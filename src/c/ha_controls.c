#include <pebble.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

// Control Center is a separate window stack from the established voice/audio UI.
// Keep watch memory bounded and never expose high-risk device domains.
#define PAGE_SIZE 32
// A page is an internal RAM/storage window, not a device limit.
// Only identity and room metadata survive watch restarts. Live status and
// adjustable controls are intentionally discarded and read on selection.
#define NAME_LEN 36
#define ROOM_LEN 22
#define STATE_LEN 12
#define CACHE_ROWS_PER_KEY 3
#define CACHE_COUNT_KEY 3800
#define CACHE_REV_KEY 3801
#define CACHE_STAMP_KEY 3802
#define CACHE_MODE_KEY 3803
#define CACHE_OFFSET_KEY 3804
#define CACHE_MORE_KEY 3805
#define CACHE_TOTAL_KEY 3806
#define CACHE_SCHEMA_KEY 3807
#define CACHE_SCHEMA_VERSION 3
#define CACHE_FIRST_ROW_KEY 3900
#define CACHE_REFRESH_SECONDS 3600
typedef struct {
  char name[NAME_LEN],room[ROOM_LEN];
  uint8_t kind;
  bool favorite;
} CachedRow;
typedef struct {
  char name[NAME_LEN],room[ROOM_LEN];
  uint8_t kind;
  bool favorite;
  char state[STATE_LEN]; // RAM only, never persisted
  bool advanced;        // RAM only, never persisted
} ControlRow;
typedef char cache_row_chunk_fits_persist_value[
  sizeof(CachedRow)*CACHE_ROWS_PER_KEY<=PERSIST_DATA_MAX_LENGTH?1:-1];
typedef char cache_page_fits_minimum_quota[
  sizeof(CachedRow)*PAGE_SIZE+16*20+128<4096?1:-1];
static ControlRow s_rows[PAGE_SIZE];
static ControlRow s_incoming[PAGE_SIZE];
static bool s_received_rows=false;
static int s_incoming_count=0;
static int s_page_offset=0,s_request_offset=0,s_total_count=0,s_cached_mode=0;
static bool s_has_more=false;
static int s_count=0, s_mode=0; // 0: rooms; 1: favorites; 2: scenes/scripts
static uint8_t s_visible[PAGE_SIZE];
static int s_visible_count=0, s_room_count=0;
static char s_rooms[PAGE_SIZE][ROOM_LEN];
static uint8_t s_room_sizes[PAGE_SIZE];
static uint8_t s_room_starts[PAGE_SIZE];
static bool s_next_page=false,s_prev_page=false;
static bool s_loading=false;
static Window *s_home=NULL,*s_list=NULL,*s_detail_window=NULL,*s_settings_window=NULL,*s_volume_window=NULL;
static Layer *s_volume_settings_layer=NULL;
static Layer *s_detail_layer=NULL;
static int s_detail_index=-1,s_detail_level=-1;
static bool s_detail_adjustable=false,s_detail_busy=false,s_detail_loading=false;
static char s_detail_note[42]="";
static MenuLayer *s_home_menu=NULL,*s_menu=NULL,*s_settings_menu=NULL;
static TextLayer *s_hint=NULL;
static char s_hint_text[64]="Select: toggle or run";
static int32_t s_catalog_revision=0;
static time_t s_last_sync_at=0;
static bool s_catalog_loaded=false,s_sync_pending=false;

static bool s_large_text=false;
static bool s_night_theme=false;
static int s_theme_mode=2; // 0 day, 1 night, 2 automatic sunset via Weather+
static bool s_force_refresh_pending=false;
static char s_refresh_note[40]="Full device discovery";
int controls_voice_volume_percent(void);
void controls_voice_volume_change(int direction);
void controls_set_theme_mode(int theme_mode){
  if(theme_mode<0||theme_mode>2)return;
  s_theme_mode=theme_mode;
  if(s_settings_menu)menu_layer_reload_data(s_settings_menu);
}
static GColor ui_bg(void){return s_night_theme?GColorBlack:GColorWhite;}
static GColor ui_fg(void){return s_night_theme?GColorWhite:GColorBlack;}
static GColor ui_muted(void){return s_night_theme?PBL_IF_COLOR_ELSE(GColorLightGray,GColorWhite):PBL_IF_COLOR_ELSE(GColorDarkGray,GColorBlack);}
// Pure blue is intentionally darker than the old light cyan: white text
// remains readable over selected rows on 64-color Pebble displays.
static GColor ui_selected_bg(void){return PBL_IF_COLOR_ELSE(GColorBlue,s_night_theme?GColorWhite:GColorBlack);}
static GColor ui_selected_fg(void){return PBL_IF_COLOR_ELSE(GColorWhite,s_night_theme?GColorBlack:GColorWhite);}
static GFont title_font(void){return fonts_get_system_font(s_large_text?FONT_KEY_GOTHIC_24_BOLD:FONT_KEY_GOTHIC_18_BOLD);}
static GFont sub_font(void){return fonts_get_system_font(s_large_text?FONT_KEY_GOTHIC_18:FONT_KEY_GOTHIC_14);}
static GColor cell_fg(bool active){return active?ui_selected_fg():ui_fg();}
static GColor cell_sub(bool active){return active?ui_selected_fg():ui_muted();}
static int title_height(void){return s_large_text?48:23;}
static int sub_top(void){return s_large_text?56:23;}
static int row_height(void){return s_large_text?80:46;}
static int title_top(void){return s_large_text?7:3;}
static int home_title_top(void){return s_large_text?(row_height()-title_height())/2:3;}
static void refresh_menu(MenuLayer *m,Window *w){
  if(w)window_set_background_color(w,ui_bg());
  if(!m)return;
  menu_layer_set_normal_colors(m,ui_bg(),ui_fg());
  menu_layer_set_highlight_colors(m,ui_selected_bg(),ui_selected_fg());
  menu_layer_reload_data(m);
}
void controls_apply_settings(bool large,bool dark){
  if(s_large_text==large&&s_night_theme==dark)return;
  s_large_text=large;s_night_theme=dark;
  refresh_menu(s_home_menu,s_home);
  refresh_menu(s_menu,s_list);
  refresh_menu(s_settings_menu,s_settings_window);
  if(s_volume_window)window_set_background_color(s_volume_window,ui_bg());
  if(s_volume_settings_layer)layer_mark_dirty(s_volume_settings_layer);
  if(s_detail_window)window_set_background_color(s_detail_window,ui_bg());
  if(s_detail_layer)layer_mark_dirty(s_detail_layer);
  if(s_hint){
    text_layer_set_background_color(s_hint,ui_bg());
    text_layer_set_text_color(s_hint,ui_fg());
    text_layer_set_font(s_hint,sub_font());
  }
}
static bool send_command(const char *command,int index){
  DictionaryIterator *out=NULL;
  if(app_message_outbox_begin(&out)!=APP_MSG_OK||!out)return false;
  dict_write_cstring(out,MESSAGE_KEY_COMMAND,command);
  if(index>=0)dict_write_int32(out,MESSAGE_KEY_CTRL_INDEX,index);
  if(strcmp(command,"CTRL_REQUEST")==0){
    bool same=s_request_offset==s_page_offset&&s_cached_mode==s_mode;
    dict_write_int32(out,MESSAGE_KEY_CTRL_REV,same?s_catalog_revision:0);
    dict_write_int32(out,MESSAGE_KEY_CTRL_OFFSET,s_request_offset);
  }
  dict_write_end(out);
  return app_message_outbox_send()==APP_MSG_OK;
}
static GColor kind_color(uint8_t kind){
#ifdef PBL_COLOR
  switch(kind){
    case 1:return GColorChromeYellow; // lights
    case 3:return GColorVividCerulean; // fans
    case 4:return GColorOrange; // covers
    case 5:case 11:return GColorChromeYellow; // bright for dark ink
    case 6:return GColorCyan; // bright for dark ink
    case 7:return GColorOrange; // bright for dark ink
    case 8:return GColorVividCerulean; // microphone
    case 9:return GColorChromeYellow; // favorites
    case 10:return GColorCyan;
    default:return GColorLightGray;
  }
#else
  return s_night_theme?GColorWhite:GColorBlack;
#endif
}
static GColor badge_fill(uint8_t kind,bool selected){
#ifdef PBL_COLOR
  return selected?GColorWhite:kind_color(kind);
#else
  return selected?ui_selected_fg():kind_color(kind);
#endif
}
static GColor badge_ink(bool selected){
#ifdef PBL_COLOR
  return GColorBlack; // all color badge fills are deliberately light
#else
  return selected?ui_selected_bg():ui_bg();
#endif
}
static void paint_badge(GContext *ctx,GPoint c,uint8_t kind,bool highlighted,const char *state){
  // Filled/bright = ON; outlined/muted = OFF. Unknown is muted as well.
  // Non-toggle items keep their original full-color category badge.
  bool dimmed=state&&(strcmp(state,"off")==0||
    strcmp(state,"unavailable")==0||strcmp(state,"unknown")==0);
  GColor ink=dimmed?(highlighted?ui_selected_fg():ui_muted()):badge_ink(highlighted);
  graphics_context_set_fill_color(ctx,
    dimmed?(highlighted?ui_selected_bg():ui_bg()):badge_fill(kind,highlighted));
  graphics_fill_circle(ctx,c,14);
  graphics_context_set_stroke_color(ctx,dimmed?(highlighted?ui_selected_fg():ui_muted()):
    (highlighted?ui_selected_fg():ui_fg()));
  graphics_context_set_stroke_width(ctx,1);
  graphics_draw_circle(ctx,c,14);
  graphics_context_set_stroke_color(ctx,ink);
  graphics_context_set_fill_color(ctx,ink);
  graphics_context_set_stroke_width(ctx,2);
  switch(kind){
    case 1: // lightbulb: globe, stem, screw base
      graphics_draw_circle(ctx,GPoint(c.x,c.y-4),6);
      graphics_draw_line(ctx,GPoint(c.x-3,c.y+1),GPoint(c.x-3,c.y+6));
      graphics_draw_line(ctx,GPoint(c.x+3,c.y+1),GPoint(c.x+3,c.y+6));
      graphics_draw_line(ctx,GPoint(c.x-4,c.y+7),GPoint(c.x+4,c.y+7));
      graphics_draw_line(ctx,GPoint(c.x-3,c.y+10),GPoint(c.x+3,c.y+10));
      break;
    case 2: // switch
      graphics_draw_round_rect(ctx,GRect(c.x-10,c.y-5,20,10),5);
      graphics_fill_circle(ctx,GPoint(c.x+4,c.y),4);
      break;
    case 3: // 3-blade fan
      graphics_fill_circle(ctx,c,3);
      graphics_fill_circle(ctx,GPoint(c.x,c.y-7),4);
      graphics_fill_circle(ctx,GPoint(c.x-7,c.y+5),4);
      graphics_fill_circle(ctx,GPoint(c.x+7,c.y+5),4);
      break;
    case 4: // shades
      graphics_draw_line(ctx,GPoint(c.x-9,c.y-8),GPoint(c.x+9,c.y-8));
      graphics_draw_line(ctx,GPoint(c.x-8,c.y-4),GPoint(c.x+8,c.y-4));
      graphics_draw_line(ctx,GPoint(c.x-8,c.y+1),GPoint(c.x+8,c.y+1));
      graphics_draw_line(ctx,GPoint(c.x-8,c.y+6),GPoint(c.x+8,c.y+6));
      break;
    case 5:case 11: // scene: play triangle
      graphics_draw_line(ctx,GPoint(c.x-5,c.y-8),GPoint(c.x+7,c.y));
      graphics_draw_line(ctx,GPoint(c.x+7,c.y),GPoint(c.x-5,c.y+8));
      graphics_draw_line(ctx,GPoint(c.x-5,c.y+8),GPoint(c.x-5,c.y-8));
      break;
    case 6: // script / workflow
      graphics_draw_line(ctx,GPoint(c.x-7,c.y-9),GPoint(c.x,c.y-2));
      graphics_draw_line(ctx,GPoint(c.x,c.y-2),GPoint(c.x-7,c.y+7));
      graphics_draw_line(ctx,GPoint(c.x+1,c.y+8),GPoint(c.x+9,c.y+8));
      break;
    case 7: // automation
      graphics_draw_circle(ctx,c,7);
      graphics_fill_circle(ctx,c,3);
      graphics_draw_line(ctx,GPoint(c.x,c.y-11),GPoint(c.x,c.y-7));
      graphics_draw_line(ctx,GPoint(c.x,c.y+7),GPoint(c.x,c.y+11));
      graphics_draw_line(ctx,GPoint(c.x-11,c.y),GPoint(c.x-7,c.y));
      graphics_draw_line(ctx,GPoint(c.x+7,c.y),GPoint(c.x+11,c.y));
      break;
    case 8: // microphone
      graphics_draw_round_rect(ctx,GRect(c.x-4,c.y-9,8,13),4);
      graphics_draw_line(ctx,GPoint(c.x-7,c.y),GPoint(c.x-7,c.y+5));
      graphics_draw_line(ctx,GPoint(c.x+7,c.y),GPoint(c.x+7,c.y+5));
      graphics_draw_line(ctx,GPoint(c.x-7,c.y+5),GPoint(c.x+7,c.y+5));
      graphics_draw_line(ctx,GPoint(c.x,c.y+5),GPoint(c.x,c.y+10));
      break;
    case 9: // star marker: simple sparkle
      graphics_draw_line(ctx,GPoint(c.x,c.y-10),GPoint(c.x,c.y+10));
      graphics_draw_line(ctx,GPoint(c.x-10,c.y),GPoint(c.x+10,c.y));
      graphics_draw_line(ctx,GPoint(c.x-6,c.y-6),GPoint(c.x+6,c.y+6));
      graphics_draw_line(ctx,GPoint(c.x+6,c.y-6),GPoint(c.x-6,c.y+6));
      break;
    case 12: // settings cog: eight rays around a center
      graphics_draw_circle(ctx,c,7);
      graphics_fill_circle(ctx,c,3);
      graphics_draw_line(ctx,GPoint(c.x-11,c.y),GPoint(c.x-7,c.y));
      graphics_draw_line(ctx,GPoint(c.x+7,c.y),GPoint(c.x+11,c.y));
      graphics_draw_line(ctx,GPoint(c.x,c.y-11),GPoint(c.x,c.y-7));
      graphics_draw_line(ctx,GPoint(c.x,c.y+7),GPoint(c.x,c.y+11));
      break;
    case 10: // house outline
      graphics_draw_line(ctx,GPoint(c.x-10,c.y-1),GPoint(c.x,c.y-10));
      graphics_draw_line(ctx,GPoint(c.x,c.y-10),GPoint(c.x+10,c.y-1));
      graphics_draw_line(ctx,GPoint(c.x-7,c.y-2),GPoint(c.x-7,c.y+9));
      graphics_draw_line(ctx,GPoint(c.x+7,c.y-2),GPoint(c.x+7,c.y+9));
      graphics_draw_line(ctx,GPoint(c.x-7,c.y+9),GPoint(c.x+7,c.y+9));
      break;
    default: // generic device
      graphics_draw_circle(ctx,c,7);
  }
}
// Device rows remain indexed by the phone's original catalog order. Room
// headers are visual MenuLayer sections and MUST NOT change CTRL_ACT indices.
// A page has local catalog indices. Navigation sections do not map to
// entities and never send control commands.
static uint16_t base_sections(void){
  return s_mode==0&&s_room_count>0?s_room_count:1;
}
static int nav_action(MenuIndex *idx){
  if(s_page_offset>0&&idx->section==0)return -1;
  if(s_has_more&&idx->section==base_sections()+(s_page_offset>0?1:0))return 1;
  return 0;
}
static int catalog_index_for(MenuIndex *idx){
  if(nav_action(idx)!=0)return -1;
  uint16_t sec=idx->section-(s_page_offset>0?1:0);
  if(s_mode!=0)return sec==0&&idx->row<s_visible_count?s_visible[idx->row]:-1;
  if(s_room_count==0||sec>=s_room_count)return -1;
  int vi=s_room_starts[sec]+idx->row;
  if(idx->row>=s_room_sizes[sec]||vi>=s_visible_count)return -1;
  return s_visible[vi];
}
static void draw_cell(GContext *ctx,const Layer *cell,MenuIndex *idx,void *data){
  GRect b=layer_get_bounds(cell);
  bool active=menu_cell_layer_is_highlighted(cell);
  int nav=nav_action(idx);
  if(nav){
    graphics_context_set_text_color(ctx,cell_fg(active));
    char label[42];
    snprintf(label,sizeof(label),"%s",nav>0?"More devices  >":"<  Previous devices");
    graphics_draw_text(ctx,label,title_font(),GRect(10,6,b.size.w-20,b.size.h-8),
      GTextOverflowModeTrailingEllipsis,GTextAlignmentCenter,NULL);
    return;
  }
  if(!s_visible_count){
    graphics_context_set_text_color(ctx,cell_fg(active));
    graphics_draw_text(ctx,s_loading?"Loading devices...":"No devices to show",
      fonts_get_system_font(FONT_KEY_GOTHIC_18),GRect(8,5,b.size.w-16,b.size.h-8),
      GTextOverflowModeWordWrap,GTextAlignmentCenter,NULL);
    return;
  }
  int catalog_index=catalog_index_for(idx);
  if(catalog_index<0)return;
  ControlRow *r=&s_rows[catalog_index];
  int x=PBL_IF_ROUND_ELSE(35,8);
  paint_badge(ctx,GPoint(x+13,b.size.h/2),r->kind,active,r->state);
  // One line per device (two only in the large-accessibility-text mode).
  // State is carried by the badge, not by a wasteful subtitle row.
  int left=x+34;
  int right=r->favorite?PBL_IF_ROUND_ELSE(34,21):PBL_IF_ROUND_ELSE(15,7);
  int h=s_large_text?48:26;
  graphics_context_set_text_color(ctx,cell_fg(active));
  graphics_draw_text(ctx,r->name,title_font(),
    GRect(left,(b.size.h-h)/2,b.size.w-left-right,h),
    s_large_text?GTextOverflowModeWordWrap:GTextOverflowModeTrailingEllipsis,
    GTextAlignmentLeft,NULL);
  if(r->favorite){
    graphics_context_set_text_color(ctx,cell_sub(active));
    graphics_draw_text(ctx,"*",fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
      GRect(b.size.w-PBL_IF_ROUND_ELSE(33,18),(b.size.h-25)/2,15,25),
      GTextOverflowModeFill,GTextAlignmentCenter,NULL);
  }
}
// A single row is below Pebble's 256-byte persistent storage entry limit.
// Store the watch catalog once, then rebuild Favorites and Rooms locally.
static void cache_schema_migrate(void){
  if(persist_exists(CACHE_SCHEMA_KEY)&&
     persist_read_int(CACHE_SCHEMA_KEY)==CACHE_SCHEMA_VERSION)return;
  // v1.5.x stored state and capability in 48 persistent records. Remove the
  // old blocks before writing the smaller v3 metadata-only pages, otherwise
  // the now-unused old blocks can exhaust the 4KB quota.
  for(int i=0;i<48;i++)persist_delete(CACHE_FIRST_ROW_KEY+i);
  persist_delete(CACHE_COUNT_KEY);persist_delete(CACHE_REV_KEY);
  persist_delete(CACHE_STAMP_KEY);persist_delete(CACHE_MODE_KEY);
  persist_delete(CACHE_OFFSET_KEY);persist_delete(CACHE_MORE_KEY);
  persist_delete(CACHE_TOTAL_KEY);
  persist_write_int(CACHE_SCHEMA_KEY,CACHE_SCHEMA_VERSION);
}
static void catalog_restore(void){
  if(s_catalog_loaded)return;
  s_catalog_loaded=true;
  cache_schema_migrate();
  int count=persist_exists(CACHE_COUNT_KEY)?persist_read_int(CACHE_COUNT_KEY):0;
  if(count<0||count>PAGE_SIZE)return;
  for(int start=0;start<count;start+=CACHE_ROWS_PER_KEY){
    CachedRow block[CACHE_ROWS_PER_KEY];
    int n=(count-start)>CACHE_ROWS_PER_KEY?CACHE_ROWS_PER_KEY:(count-start);
    int size=n*(int)sizeof(CachedRow);
    if(size>PERSIST_DATA_MAX_LENGTH||
       persist_get_size(CACHE_FIRST_ROW_KEY+start/CACHE_ROWS_PER_KEY)!=size||
       persist_read_data(CACHE_FIRST_ROW_KEY+start/CACHE_ROWS_PER_KEY,block,size)!=size){
      s_count=0;s_catalog_revision=0;return;
    }
    for(int i=0;i<n;i++){
      ControlRow *row=&s_rows[start+i];
      memset(row,0,sizeof(*row));
      memcpy(row->name,block[i].name,NAME_LEN);
      memcpy(row->room,block[i].room,ROOM_LEN);
      row->name[NAME_LEN-1]=0;row->room[ROOM_LEN-1]=0;
      row->kind=block[i].kind;row->favorite=block[i].favorite;
    }
  }
  s_count=count;
  s_catalog_revision=persist_exists(CACHE_REV_KEY)?persist_read_int(CACHE_REV_KEY):0;
  s_last_sync_at=persist_exists(CACHE_STAMP_KEY)?(time_t)persist_read_int(CACHE_STAMP_KEY):0;
  s_cached_mode=persist_exists(CACHE_MODE_KEY)?persist_read_int(CACHE_MODE_KEY):0;
  s_page_offset=persist_exists(CACHE_OFFSET_KEY)?persist_read_int(CACHE_OFFSET_KEY):0;
  s_has_more=persist_exists(CACHE_MORE_KEY)?persist_read_int(CACHE_MORE_KEY)!=0:false;
  s_total_count=persist_exists(CACHE_TOTAL_KEY)?persist_read_int(CACHE_TOTAL_KEY):count;
  s_request_offset=s_page_offset;
}
static bool catalog_store(void){
  for(int start=0;start<s_count;start+=CACHE_ROWS_PER_KEY){
    CachedRow block[CACHE_ROWS_PER_KEY];
    int n=(s_count-start)>CACHE_ROWS_PER_KEY?CACHE_ROWS_PER_KEY:(s_count-start);
    int size=n*(int)sizeof(CachedRow);
    for(int i=0;i<n;i++){
      ControlRow *row=&s_rows[start+i];
      memset(&block[i],0,sizeof(CachedRow));
      memcpy(block[i].name,row->name,NAME_LEN);
      memcpy(block[i].room,row->room,ROOM_LEN);
      block[i].kind=row->kind;block[i].favorite=row->favorite;
    }
    if(size>PERSIST_DATA_MAX_LENGTH||
       persist_write_data(CACHE_FIRST_ROW_KEY+start/CACHE_ROWS_PER_KEY,block,size)!=size)return false;
  }
  persist_write_int(CACHE_COUNT_KEY,s_count);
  persist_write_int(CACHE_REV_KEY,s_catalog_revision);
  persist_write_int(CACHE_STAMP_KEY,(int)s_last_sync_at);
  persist_write_int(CACHE_MODE_KEY,s_cached_mode);
  persist_write_int(CACHE_OFFSET_KEY,s_page_offset);
  persist_write_int(CACHE_MORE_KEY,s_has_more?1:0);
  persist_write_int(CACHE_TOTAL_KEY,s_total_count);
  return true;
}
static void visible_rebuild(void){
  s_visible_count=0;
  for(int i=0;i<s_count;i++){
    bool include=s_mode==1?s_rows[i].favorite:
      s_mode==2?(s_rows[i].kind==5||s_rows[i].kind==6||s_rows[i].kind==7):true;
    if(include)s_visible[s_visible_count++]=(uint8_t)i;
  }
}
static bool catalog_refresh_due(void){
  time_t now=time(NULL);
  return s_catalog_revision==0||s_last_sync_at==0||now<s_last_sync_at||
    (now-s_last_sync_at)>=CACHE_REFRESH_SECONDS;
}
static void catalog_request_if_due(void){
  if(s_sync_pending||!catalog_refresh_due())return;
  s_sync_pending=send_command("CTRL_REQUEST",s_mode);
}
static uint16_t num_sections(MenuLayer *m,void *data){
  return base_sections()+(s_page_offset>0?1:0)+(s_has_more?1:0);
}
static int16_t room_header_height(MenuLayer *m,uint16_t section,void *data){
  if((s_page_offset>0&&section==0)||
     (s_has_more&&section==base_sections()+(s_page_offset>0?1:0)))return 0;
  return s_mode==0&&s_room_count>0?(s_large_text?28:24):0;
}
static void draw_room_header(GContext *ctx,const Layer *cell,uint16_t section,void *data){
  if(s_mode!=0||s_room_count==0||nav_action(&(MenuIndex){.section=section,.row=0}))return;
  uint16_t sec=section-(s_page_offset>0?1:0);
  if(sec>=s_room_count)return;
  GRect b=layer_get_bounds(cell);
  char title[ROOM_LEN];
  snprintf(title,sizeof(title),"%s",s_rooms[sec]);
  for(char *p=title;*p;p++)if(*p>='a'&&*p<='z')*p-=('a'-'A');
  graphics_context_set_text_color(ctx,ui_muted());
  graphics_draw_text(ctx,title,
    fonts_get_system_font(s_large_text?FONT_KEY_GOTHIC_18_BOLD:FONT_KEY_GOTHIC_14_BOLD),
    GRect(PBL_IF_ROUND_ELSE(24,8),s_large_text?1:2,
      b.size.w-PBL_IF_ROUND_ELSE(48,16),s_large_text?27:22),
    GTextOverflowModeTrailingEllipsis,
    PBL_IF_ROUND_ELSE(GTextAlignmentCenter,GTextAlignmentLeft),NULL);
}
static uint16_t num_rows(MenuLayer *m,uint16_t section,void *data){
  if((s_page_offset>0&&section==0)||
     (s_has_more&&section==base_sections()+(s_page_offset>0?1:0)))return 1;
  uint16_t sec=section-(s_page_offset>0?1:0);
  if(s_mode==0&&s_room_count>0)
    return sec<s_room_count?s_room_sizes[sec]:0;
  return sec==0?(s_visible_count?s_visible_count:1):0;
}

static int16_t cell_height(MenuLayer *m,MenuIndex *idx,void *data){
  // Home screen retains two-line descriptions; device menu rows are compact.
  return m==s_home_menu?row_height():(s_large_text?58:38);
}

static void detail_draw(Layer *layer,GContext *ctx){
  if(s_detail_index<0||s_detail_index>=s_count)return;
  ControlRow *r=&s_rows[s_detail_index];
  GRect b=layer_get_bounds(layer);
  graphics_context_set_text_color(ctx,ui_muted());
  graphics_draw_text(ctx,r->room,fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
    GRect(10,3,b.size.w-20,21),GTextOverflowModeTrailingEllipsis,GTextAlignmentCenter,NULL);
  graphics_context_set_text_color(ctx,ui_fg());
  graphics_draw_text(ctx,r->name,fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
    GRect(10,24,b.size.w-20,47),GTextOverflowModeWordWrap,GTextAlignmentCenter,NULL);
  const char *status=strcmp(r->state,"on")==0?"ON":
    strcmp(r->state,"off")==0?"OFF":r->state;
  int status_y=b.size.h>=200?79:68;
  graphics_draw_text(ctx,status,fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD),
    GRect(10,status_y,b.size.w-20,36),GTextOverflowModeTrailingEllipsis,GTextAlignmentCenter,NULL);
  if(s_detail_loading){
    graphics_draw_text(ctx,"Reading state...",fonts_get_system_font(FONT_KEY_GOTHIC_18),
      GRect(8,status_y+37,b.size.w-16,27),GTextOverflowModeTrailingEllipsis,GTextAlignmentCenter,NULL);
  }else if(s_detail_adjustable){
    char level[24];
    if(s_detail_level<0)snprintf(level,sizeof(level),"Level: --");
    else snprintf(level,sizeof(level),"%d%%",s_detail_level);
    graphics_draw_text(ctx,level,fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
      GRect(10,status_y+36,b.size.w-20,31),GTextOverflowModeTrailingEllipsis,GTextAlignmentCenter,NULL);
    if(b.size.h>=190&&s_detail_level>=0){
      GRect track=GRect(22,b.size.h-60,b.size.w-44,10);
      graphics_context_set_stroke_color(ctx,ui_fg());
      graphics_draw_rect(ctx,track);
      graphics_context_set_fill_color(ctx,ui_fg());
      graphics_fill_rect(ctx,GRect(track.origin.x+2,track.origin.y+2,
        (track.size.w-4)*s_detail_level/100,track.size.h-4),0,GCornerNone);
    }
  }
  const char *hint=s_detail_busy?"Updating...":
    s_detail_note[0]?s_detail_note:
    s_detail_adjustable?"UP / DOWN: level  |  SELECT: power":"SELECT: power";
  graphics_context_set_text_color(ctx,ui_muted());
  graphics_draw_text(ctx,hint,fonts_get_system_font(FONT_KEY_GOTHIC_14),
    GRect(3,b.size.h-30,b.size.w-6,29),GTextOverflowModeWordWrap,GTextAlignmentCenter,NULL);
}
static void detail_adjust_click(int direction){
  if(s_detail_busy||s_detail_loading||!s_detail_adjustable||s_detail_index<0)return;
  DictionaryIterator *out=NULL;
  if(app_message_outbox_begin(&out)!=APP_MSG_OK||!out)return;
  dict_write_cstring(out,MESSAGE_KEY_COMMAND,"CTRL_ADJUST");
  dict_write_int32(out,MESSAGE_KEY_CTRL_INDEX,s_detail_index);
  dict_write_int32(out,MESSAGE_KEY_CTRL_DIRECTION,direction);
  dict_write_end(out);
  if(app_message_outbox_send()==APP_MSG_OK){
    s_detail_busy=true;s_detail_note[0]=0;layer_mark_dirty(s_detail_layer);
  }
}
static void detail_up_click(ClickRecognizerRef recognizer,void *context){detail_adjust_click(1);}
static void detail_down_click(ClickRecognizerRef recognizer,void *context){detail_adjust_click(-1);}
static void detail_select_click(ClickRecognizerRef recognizer,void *context){
  if(s_detail_busy||s_detail_loading||s_detail_index<0)return;
  if(send_command("CTRL_ACT",s_detail_index)){
    s_detail_busy=true;s_detail_note[0]=0;layer_mark_dirty(s_detail_layer);
  }
}
static void detail_click_config(void *context){
  window_single_click_subscribe(BUTTON_ID_UP,detail_up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN,detail_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT,detail_select_click);
}
static void detail_load(Window *w){
  window_set_background_color(w,ui_bg());
  s_detail_layer=layer_create(layer_get_bounds(window_get_root_layer(w)));
  layer_set_update_proc(s_detail_layer,detail_draw);
  layer_add_child(window_get_root_layer(w),s_detail_layer);
}
static void detail_unload(Window *w){
  layer_destroy(s_detail_layer);s_detail_layer=NULL;
  window_destroy(s_detail_window);s_detail_window=NULL;
  s_detail_index=-1;s_detail_busy=false;s_detail_loading=false;
}
static void detail_push(int index,bool fetch){
  if(s_detail_window||index<0||index>=s_count)return;
  s_detail_index=index;s_detail_level=-1;s_detail_adjustable=false;
  s_detail_busy=true;s_detail_loading=true;s_detail_note[0]=0;
  s_detail_window=window_create();
  window_set_window_handlers(s_detail_window,(WindowHandlers){
    .load=detail_load,.unload=detail_unload});
  window_set_click_config_provider(s_detail_window,detail_click_config);
  window_stack_push(s_detail_window,true);
  if(fetch&&!send_command("CTRL_DETAILS",index)){
    s_detail_busy=false;s_detail_loading=false;
    snprintf(s_detail_note,sizeof(s_detail_note),"Phone busy; reopen");
    if(s_detail_layer)layer_mark_dirty(s_detail_layer);
  }
}
static void select_row(MenuLayer *m,MenuIndex *idx,void *data){
  int nav=nav_action(idx);
  if(nav){
    if(s_sync_pending)return;
    int target=s_page_offset+(nav>0?PAGE_SIZE:-PAGE_SIZE);
    if(target<0)target=0;
    s_request_offset=target;
    s_sync_pending=send_command("CTRL_REQUEST",s_mode);
    if(s_sync_pending){
      s_loading=true;
      snprintf(s_hint_text,sizeof(s_hint_text),"Loading devices...");
    }else snprintf(s_hint_text,sizeof(s_hint_text),"Phone busy; retry");
    if(s_hint)text_layer_set_text(s_hint,s_hint_text);
    return;
  }
  int index=catalog_index_for(idx);
  if(index<0)return;
  // Names and rooms appear immediately; get_state and capability detection
  // occur only when the user selects a device.
  bool queued=send_command("CTRL_INSPECT",index);
  snprintf(s_hint_text,sizeof(s_hint_text),"%s",
    queued?"Checking device...":"Phone busy; retry");
  if(s_hint)text_layer_set_text(s_hint,s_hint_text);
}
static void list_load(Window *w){
  GRect b=layer_get_bounds(window_get_root_layer(w));
  window_set_background_color(w,ui_bg());
  s_menu=menu_layer_create(GRect(0,0,b.size.w,b.size.h-20));
  menu_layer_set_callbacks(s_menu,NULL,(MenuLayerCallbacks){
    .get_num_sections=num_sections,.get_num_rows=num_rows,
    .get_header_height=room_header_height,.get_cell_height=cell_height,
    .draw_header=draw_room_header,.draw_row=draw_cell,.select_click=select_row
  });
  menu_layer_set_normal_colors(s_menu,ui_bg(),ui_fg());
  menu_layer_set_highlight_colors(s_menu,ui_selected_bg(),ui_selected_fg());
#ifdef PBL_ROUND
  menu_layer_set_center_focused(s_menu,true);
#endif
  menu_layer_set_click_config_onto_window(s_menu,w);
  layer_add_child(window_get_root_layer(w),menu_layer_get_layer(s_menu));
  s_hint=text_layer_create(GRect(0,b.size.h-20,b.size.w,20));
  text_layer_set_background_color(s_hint,ui_bg());
  text_layer_set_text_color(s_hint,ui_fg());
  text_layer_set_font(s_hint,sub_font());
  text_layer_set_text_alignment(s_hint,GTextAlignmentCenter);
  text_layer_set_text(s_hint,s_hint_text);
  layer_add_child(window_get_root_layer(w),text_layer_get_layer(s_hint));
}
static void list_unload(Window *w){
  menu_layer_destroy(s_menu);s_menu=NULL;
  text_layer_destroy(s_hint);s_hint=NULL;
  window_destroy(s_list);s_list=NULL;
}
// The phone supplies sorted rooms. Construct visual sections over cached
// rows; opening or scrolling them never causes another Bluetooth message.
static void list_push(void){
  if(s_list)return;
  s_list=window_create();
  window_set_window_handlers(s_list,(WindowHandlers){
    .load=list_load,.unload=list_unload
  });
  window_stack_push(s_list,true);
}
static void rooms_rebuild(void){
  s_room_count=0;
  if(s_mode!=0)return;
  for(int vi=0;vi<s_visible_count;vi++){
    const ControlRow *r=&s_rows[s_visible[vi]];
    bool new_room=s_room_count==0||
      strcmp(s_rooms[s_room_count-1],r->room)!=0;
    if(new_room){
      if(s_room_count>=PAGE_SIZE)break;
      snprintf(s_rooms[s_room_count],ROOM_LEN,"%s",r->room);
      s_room_starts[s_room_count]=(uint8_t)vi;
      s_room_sizes[s_room_count]=0;
      s_room_count++;
    }
    s_room_sizes[s_room_count-1]++;
  }
}
void controls_open_mode(int mode){
  if(s_list)return;
  catalog_restore();
  s_mode=mode;
  s_loading=s_count==0;
  visible_rebuild();
  rooms_rebuild();
  snprintf(s_hint_text,sizeof(s_hint_text),"%s",
    mode==0?"Select to control":mode==1?"Favorite devices":"Scenes and scripts");
  // All modes use one scrollable list. Room headers are not selectable.
  list_push();
  // Browsing locally cached rooms or favorites requires ZERO phone messages.
  catalog_request_if_due();
}
// Legacy entry point used by earlier code.
void controls_open(void){controls_open_mode(0);}
void controls_start_voice(void);
static void home_back_handler(ClickRecognizerRef recognizer,void *context){
  window_stack_pop_all(true);
}
// Settings is native to the watch; only changed preferences and explicit
// refresh requests are sent to the phone. Local volume uses voice mixer.
static const char *settings_names[]={
  "Theme","Text size","Voice volume","Force recheck"
};
static uint16_t settings_rows(MenuLayer *menu,uint16_t section,void *ctx){return 4;}
static int16_t settings_height(MenuLayer *menu,MenuIndex *idx,void *ctx){
  return s_large_text?75:57;
}
static void settings_draw(GContext *ctx,const Layer *cell,MenuIndex *idx,void *data){
  if(idx->row>=4)return;
  GRect b=layer_get_bounds(cell);
  bool selected=menu_cell_layer_is_highlighted(cell);
  GColor fg=cell_fg(selected);
  graphics_context_set_text_color(ctx,fg);
  graphics_draw_text(ctx,settings_names[idx->row],
    fonts_get_system_font(s_large_text?FONT_KEY_GOTHIC_24_BOLD:FONT_KEY_GOTHIC_18_BOLD),
    GRect(10,3,b.size.w-18,s_large_text?35:26),
    GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  char value[40]="";
  if(idx->row==0)snprintf(value,sizeof(value),"%s",
    s_theme_mode==0?"Day":s_theme_mode==1?"Night":"Auto (Weather+)");
  if(idx->row==1)snprintf(value,sizeof(value),"%s",s_large_text?"Large":"Normal");
  if(idx->row==2){
    int volume=controls_voice_volume_percent();
    if(volume<0)snprintf(value,sizeof(value),"Speaker unavailable");
    else snprintf(value,sizeof(value),"%d%% (Up / Down)",volume);
  }
  if(idx->row==3)snprintf(value,sizeof(value),"%s",s_refresh_note);
  graphics_context_set_text_color(ctx,cell_sub(selected));
  graphics_draw_text(ctx,value,
    fonts_get_system_font(s_large_text?FONT_KEY_GOTHIC_18:FONT_KEY_GOTHIC_14),
    GRect(10,s_large_text?39:29,b.size.w-18,s_large_text?29:23),
    GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
}
static void volume_settings_draw(Layer *layer,GContext *ctx){
  GRect b=layer_get_bounds(layer);
  int volume=controls_voice_volume_percent();
  graphics_context_set_text_color(ctx,ui_fg());
  graphics_draw_text(ctx,"Voice volume",
    fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
    GRect(10,14,b.size.w-20,40),GTextOverflowModeTrailingEllipsis,
    GTextAlignmentCenter,NULL);
  char label[24];
  if(volume<0)snprintf(label,sizeof(label),"No speaker");
  else snprintf(label,sizeof(label),"%d%%",volume);
  graphics_draw_text(ctx,label,fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD),
    GRect(12,b.size.h/2-35,b.size.w-24,46),
    GTextOverflowModeTrailingEllipsis,GTextAlignmentCenter,NULL);
  if(volume>=0){
    GRect track=GRect(20,b.size.h/2+24,b.size.w-40,12);
    graphics_context_set_stroke_color(ctx,ui_fg());
    graphics_draw_rect(ctx,track);
    graphics_context_set_fill_color(ctx,ui_fg());
    graphics_fill_rect(ctx,GRect(track.origin.x+2,track.origin.y+2,
      (track.size.w-4)*volume/100,track.size.h-4),0,GCornerNone);
  }
  graphics_context_set_text_color(ctx,ui_muted());
  graphics_draw_text(ctx,"UP / DOWN: 10%    BACK: done",
    fonts_get_system_font(FONT_KEY_GOTHIC_14),
    GRect(4,b.size.h-31,b.size.w-8,27),
    GTextOverflowModeWordWrap,GTextAlignmentCenter,NULL);
}
static void volume_settings_step(int direction){
  controls_voice_volume_change(direction);
  if(s_volume_settings_layer)layer_mark_dirty(s_volume_settings_layer);
}
static void volume_settings_up(ClickRecognizerRef rec,void *ctx){volume_settings_step(1);}
static void volume_settings_down(ClickRecognizerRef rec,void *ctx){volume_settings_step(-1);}
static void volume_settings_done(ClickRecognizerRef rec,void *ctx){window_stack_pop(true);}
static void volume_settings_clicks(void *ctx){
  window_single_click_subscribe(BUTTON_ID_UP,volume_settings_up);
  window_single_click_subscribe(BUTTON_ID_DOWN,volume_settings_down);
  window_single_click_subscribe(BUTTON_ID_SELECT,volume_settings_done);
}
static void volume_settings_load(Window *w){
  window_set_background_color(w,ui_bg());
  s_volume_settings_layer=layer_create(layer_get_bounds(window_get_root_layer(w)));
  layer_set_update_proc(s_volume_settings_layer,volume_settings_draw);
  layer_add_child(window_get_root_layer(w),s_volume_settings_layer);
}
static void volume_settings_unload(Window *w){
  layer_destroy(s_volume_settings_layer);s_volume_settings_layer=NULL;
  window_destroy(s_volume_window);s_volume_window=NULL;
  if(s_settings_menu)menu_layer_reload_data(s_settings_menu);
}
static void volume_settings_open(void){
  if(s_volume_window)return;
  s_volume_window=window_create();
  window_set_window_handlers(s_volume_window,(WindowHandlers){
    .load=volume_settings_load,.unload=volume_settings_unload
  });
  window_set_click_config_provider(s_volume_window,volume_settings_clicks);
  window_stack_push(s_volume_window,true);
}
static void settings_select(MenuLayer *menu,MenuIndex *idx,void *data){
  switch(idx->row){
    case 0:{
      int next=(s_theme_mode+1)%3;
      if(!send_command("CTRL_THEME_SET",next))return;
      controls_set_theme_mode(next);
      if(next!=2)controls_apply_settings(s_large_text,next==1);
      break;
    }
    case 1:{
      int next=s_large_text?0:1;
      if(!send_command("CTRL_FONT_SET",next))return;
      controls_apply_settings(next!=0,s_night_theme);
      break;
    }
    case 2:volume_settings_open();break;
    case 3:
      if(s_force_refresh_pending)return;
      if(!send_command("CTRL_FORCE_REFRESH",-1)){
        snprintf(s_refresh_note,sizeof(s_refresh_note),"Phone busy; retry");break;
      }
      s_force_refresh_pending=true;
      s_sync_pending=true;
      s_catalog_revision=0;
      persist_write_int(CACHE_REV_KEY,0);
      snprintf(s_refresh_note,sizeof(s_refresh_note),"Refreshing from Bridge...");
      break;
  }
  if(s_settings_menu)menu_layer_reload_data(s_settings_menu);
}
static void settings_load(Window *w){
  window_set_background_color(w,ui_bg());
  GRect b=layer_get_bounds(window_get_root_layer(w));
  s_settings_menu=menu_layer_create(b);
  menu_layer_set_callbacks(s_settings_menu,NULL,(MenuLayerCallbacks){
    .get_num_rows=settings_rows,.get_cell_height=settings_height,
    .draw_row=settings_draw,.select_click=settings_select
  });
  menu_layer_set_normal_colors(s_settings_menu,ui_bg(),ui_fg());
  menu_layer_set_highlight_colors(s_settings_menu,ui_selected_bg(),ui_selected_fg());
#ifdef PBL_ROUND
  menu_layer_set_center_focused(s_settings_menu,true);
#endif
  menu_layer_set_click_config_onto_window(s_settings_menu,w);
  layer_add_child(window_get_root_layer(w),menu_layer_get_layer(s_settings_menu));
}
static void settings_unload(Window *w){
  menu_layer_destroy(s_settings_menu);s_settings_menu=NULL;
  window_destroy(s_settings_window);s_settings_window=NULL;
}
static void settings_open(void){
  if(s_settings_window)return;
  s_settings_window=window_create();
  window_set_window_handlers(s_settings_window,(WindowHandlers){
    .load=settings_load,.unload=settings_unload
  });
  window_stack_push(s_settings_window,true);
}
static const char *home_names[]={"Voice Assistant","Favorites","Devices by Room","Scenes & Scripts","Settings"};
static const char *home_subs[]={"Dictation and conversation","Your pinned controls","Browse Home Assistant","Run saved actions","Theme, text, volume, refresh"};
static void home_draw(GContext *ctx,const Layer *cell,MenuIndex *idx,void *data){
  GRect b=layer_get_bounds(cell);
  bool active=menu_cell_layer_is_highlighted(cell);
  paint_badge(ctx,GPoint(PBL_IF_ROUND_ELSE(40,20),b.size.h/2),(uint8_t)(idx->row+8),active,NULL);
  int x=PBL_IF_ROUND_ELSE(60,39);
  graphics_context_set_text_color(ctx,cell_fg(active));
  graphics_draw_text(ctx,home_names[idx->row],title_font(),
    GRect(x,home_title_top(),b.size.w-x-7,title_height()),s_large_text?GTextOverflowModeWordWrap:GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  graphics_context_set_text_color(ctx,cell_sub(active));
  if(!s_large_text)graphics_draw_text(ctx,home_subs[idx->row],sub_font(),
    GRect(x,sub_top(),b.size.w-x-7,27),GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
}
static uint16_t home_rows(MenuLayer *m,uint16_t sec,void *ctx){return 5;}
static void home_select(MenuLayer *m,MenuIndex *idx,void *ctx){
  switch(idx->row){
    case 0:window_stack_pop(true);controls_start_voice();break;
    case 1:controls_open_mode(1);break;
    case 2:controls_open_mode(0);break;
    case 3:controls_open_mode(2);break;
    case 4:settings_open();break;
  }
}
static void home_up_click(ClickRecognizerRef recognizer,void *context){
  if(s_home_menu)menu_layer_set_selected_next(s_home_menu,true,MenuRowAlignCenter,true);
}
static void home_down_click(ClickRecognizerRef recognizer,void *context){
  if(s_home_menu)menu_layer_set_selected_next(s_home_menu,false,MenuRowAlignCenter,true);
}
static void home_select_click(ClickRecognizerRef recognizer,void *context){
  if(!s_home_menu)return;
  MenuIndex index=menu_layer_get_selected_index(s_home_menu);
  home_select(s_home_menu,&index,NULL);
}
// All click subscriptions MUST be made from a ClickConfigProvider.
// Installing one in home_load() triggered a Pebble runtime assertion.
static void home_click_config(void *context){
  window_single_click_subscribe(BUTTON_ID_UP,home_up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN,home_down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT,home_select_click);
  window_single_click_subscribe(BUTTON_ID_BACK,home_back_handler);
}
static void home_load(Window *w){
  GRect b=layer_get_bounds(window_get_root_layer(w));
  window_set_background_color(w,ui_bg());
  s_home_menu=menu_layer_create(b);
  menu_layer_set_callbacks(s_home_menu,NULL,(MenuLayerCallbacks){
    .get_num_rows=home_rows,.get_cell_height=cell_height,
    .draw_row=home_draw,.select_click=home_select
  });
  menu_layer_set_normal_colors(s_home_menu,ui_bg(),ui_fg());
  menu_layer_set_highlight_colors(s_home_menu,ui_selected_bg(),ui_selected_fg());
#ifdef PBL_ROUND
  menu_layer_set_center_focused(s_home_menu,true);
#endif
  window_set_click_config_provider(w,home_click_config);
  layer_add_child(window_get_root_layer(w),menu_layer_get_layer(s_home_menu));
}
static void home_unload(Window *w){
  menu_layer_destroy(s_home_menu);s_home_menu=NULL;
  window_destroy(s_home);s_home=NULL;
}
void controls_home_open(void){
  catalog_restore();
  if(s_home)return;
  s_home=window_create();
  window_set_window_handlers(s_home,(WindowHandlers){.load=home_load,.unload=home_unload});
  window_stack_push(s_home,true);
}
void controls_receive(DictionaryIterator *iter,const char *command){
  if(strcmp(command,"CTRL_INVALIDATE")==0){
    s_catalog_revision=0;s_last_sync_at=0;
    persist_write_int(CACHE_REV_KEY,0);
    persist_write_int(CACHE_STAMP_KEY,0);
    // Refresh on next visit, not automatically across Bluetooth.
    return;
  }
  if(strcmp(command,"CTRL_DETAIL_STATE")==0){
    Tuple *i=dict_find(iter,MESSAGE_KEY_CTRL_INDEX);
    Tuple *st=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    Tuple *level=dict_find(iter,MESSAGE_KEY_CTRL_LEVEL);
    Tuple *adj=dict_find(iter,MESSAGE_KEY_CTRL_ADJUSTABLE);
    if(!i||!st)return;
    int index=i->value->int32;
    if(index<0||index>=s_count)return;
    if(strcmp(s_rows[index].state,st->value->cstring)!=0){
      snprintf(s_rows[index].state,sizeof(s_rows[index].state),"%s",st->value->cstring);
      catalog_store_status(index);
      if(s_menu)menu_layer_reload_data(s_menu);
    }
    if(index==s_detail_index){
      s_detail_level=level?level->value->int32:-1;
      if(s_detail_level>100)s_detail_level=100;
      if(s_detail_level<0)s_detail_level=-1;
      s_detail_adjustable=adj&&adj->value->int32!=0;
      s_detail_busy=false;s_detail_loading=false;s_detail_note[0]=0;
      if(s_detail_layer)layer_mark_dirty(s_detail_layer);
    }
    return;
  }
  if(strcmp(command,"CTRL_ROW")==0){
    Tuple *i=dict_find(iter,MESSAGE_KEY_CTRL_INDEX);
    Tuple *n=dict_find(iter,MESSAGE_KEY_CTRL_NAME);
    Tuple *st=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    Tuple *room=dict_find(iter,MESSAGE_KEY_CTRL_ROOM);
    Tuple *kind=dict_find(iter,MESSAGE_KEY_CTRL_KIND);
    Tuple *fav=dict_find(iter,MESSAGE_KEY_CTRL_FAV);
    Tuple *advanced=dict_find(iter,MESSAGE_KEY_CTRL_ADVANCED);
    if(!i||!n||!st)return;
    int index=i->value->int32;
    if(index<0||index>=PAGE_SIZE)return;
    snprintf(s_rows[index].name,sizeof(s_rows[index].name),"%s",n->value->cstring);
    snprintf(s_rows[index].state,sizeof(s_rows[index].state),"%s",st->value->cstring);
    snprintf(s_rows[index].room,sizeof(s_rows[index].room),"%s",room?room->value->cstring:"Unassigned");
    s_rows[index].kind=kind?(uint8_t)kind->value->int32:0;
    s_rows[index].favorite=fav?fav->value->int32!=0:false;
    s_rows[index].advanced=advanced?advanced->value->int32!=0:false;
    if(index>=s_count)s_count=index+1;
    s_catalog_dirty=true;
    return;
  }
  if(strcmp(command,"CTRL_STATE")==0){
    Tuple *i=dict_find(iter,MESSAGE_KEY_CTRL_INDEX);
    Tuple *st=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    if(!i||!st)return;
    int index=i->value->int32;
    if(index<0||index>=s_count)return;
    if(strcmp(s_rows[index].state,st->value->cstring)!=0){
      snprintf(s_rows[index].state,sizeof(s_rows[index].state),"%s",st->value->cstring);
      catalog_store_status(index);
      if(s_menu)menu_layer_reload_data(s_menu);
    }
    return;
  }
  if(strcmp(command,"CTRL_DONE")==0){
    Tuple *count=dict_find(iter,MESSAGE_KEY_CTRL_TOTAL);
    Tuple *rev=dict_find(iter,MESSAGE_KEY_CTRL_REV);
    if(count&&rev){
      int n=count->value->int32;
      if(n<0||n>PAGE_SIZE)return;
      bool changed=s_catalog_dirty||n!=s_count;
      s_count=n;
      s_catalog_revision=rev->value->int32;
      s_last_sync_at=time(NULL);
      if(changed){
        if(!catalog_store()){
          s_catalog_revision=0;
          persist_write_int(CACHE_REV_KEY,0);
        }
      }else{
        persist_write_int(CACHE_REV_KEY,s_catalog_revision);
        persist_write_int(CACHE_STAMP_KEY,(int)s_last_sync_at);
      }
      s_catalog_dirty=false;
    }
    s_loading=false;s_sync_pending=false;
    if(s_force_refresh_pending){
      s_force_refresh_pending=false;
      snprintf(s_refresh_note,sizeof(s_refresh_note),"Updated: %d devices",s_count);
      if(s_settings_menu)menu_layer_reload_data(s_settings_menu);
    }
    visible_rebuild();
    rooms_rebuild();
    if(s_menu)menu_layer_reload_data(s_menu);
    if(s_hint)text_layer_set_text(s_hint,s_hint_text);
    return;
  }
  if(strcmp(command,"CTRL_ACTION_DONE")==0){
    Tuple *st=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    snprintf(s_hint_text,sizeof(s_hint_text),"%s",st?st->value->cstring:"Done");
    if(s_hint)text_layer_set_text(s_hint,s_hint_text);
    return;
  }
  if(strcmp(command,"CTRL_ERROR")==0){
    s_loading=false;s_sync_pending=false;
    if(s_force_refresh_pending){
      s_force_refresh_pending=false;
      snprintf(s_refresh_note,sizeof(s_refresh_note),"Refresh failed; retry");
      if(s_settings_menu)menu_layer_reload_data(s_settings_menu);
    }
    Tuple *t=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    if(s_detail_window){
      s_detail_busy=false;s_detail_loading=false;
      snprintf(s_detail_note,sizeof(s_detail_note),"%s",
        t?t->value->cstring:"Control failed");
      if(s_detail_layer)layer_mark_dirty(s_detail_layer);
    }
    snprintf(s_hint_text,sizeof(s_hint_text),"%s",t?t->value->cstring:"Control failed");
    if(s_hint)text_layer_set_text(s_hint,s_hint_text);
    if(s_menu)menu_layer_reload_data(s_menu);
    return;
  }
}
