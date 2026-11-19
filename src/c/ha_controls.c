#include <pebble.h>
#include <stdio.h>
#include <string.h>

// Control Center is a separate window stack from the established voice/audio UI.
// Keep watch memory bounded and never expose high-risk device domains.
#define CONTROL_MAX 48
#define NAME_LEN 48
#define ROOM_LEN 32
typedef struct {
  char id[64], name[NAME_LEN], state[28], room[ROOM_LEN];
  uint8_t kind;
  bool favorite;
} ControlRow;
static ControlRow s_rows[CONTROL_MAX];
static int s_count=0, s_mode=0; // 0: rooms; 1: favorites; 2: scenes/scripts
static uint8_t s_visible[CONTROL_MAX];
static int s_visible_count=0, s_room_count=0;
static char s_rooms[CONTROL_MAX][ROOM_LEN];
static uint8_t s_room_sizes[CONTROL_MAX];
static bool s_loading=false;
static Window *s_home=NULL,*s_list=NULL,*s_room_window=NULL;
static MenuLayer *s_home_menu=NULL,*s_menu=NULL,*s_room_menu=NULL;
static TextLayer *s_hint=NULL;
static char s_hint_text[64]="Select: toggle or run";

static bool s_large_text=false;
static bool s_night_theme=false;
static GColor ui_bg(void){return s_night_theme?GColorBlack:GColorWhite;}
static GColor ui_fg(void){return s_night_theme?GColorWhite:GColorBlack;}
static GColor ui_muted(void){return s_night_theme?PBL_IF_COLOR_ELSE(GColorLightGray,GColorWhite):PBL_IF_COLOR_ELSE(GColorDarkGray,GColorBlack);}
static GColor ui_selected_bg(void){return PBL_IF_COLOR_ELSE(GColorVividCerulean,GColorBlack);}
static GColor ui_selected_fg(void){return GColorWhite;}
static GFont title_font(void){return fonts_get_system_font(s_large_text?FONT_KEY_GOTHIC_24_BOLD:FONT_KEY_GOTHIC_18_BOLD);}
static GFont sub_font(void){return fonts_get_system_font(s_large_text?FONT_KEY_GOTHIC_18:FONT_KEY_GOTHIC_14);}
static GColor cell_fg(bool active){return active?ui_selected_fg():ui_fg();}
static GColor cell_sub(bool active){return active?ui_selected_fg():ui_muted();}
static int title_height(void){return s_large_text?56:24;}
static int sub_top(void){return s_large_text?59:26;}
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
  refresh_menu(s_room_menu,s_room_window);
  if(s_hint){
    text_layer_set_background_color(s_hint,ui_bg());
    text_layer_set_text_color(s_hint,ui_fg());
    text_layer_set_font(s_hint,sub_font());
  }
}
static void send_command(const char *command,int index){
  DictionaryIterator *out=NULL;
  if(app_message_outbox_begin(&out)!=APP_MSG_OK||!out)return;
  dict_write_cstring(out,MESSAGE_KEY_COMMAND,command);
  if(index>=0)dict_write_int32(out,MESSAGE_KEY_CTRL_INDEX,index);
  dict_write_end(out);
  app_message_outbox_send();
}
static GColor kind_color(uint8_t kind){
#ifdef PBL_COLOR
  switch(kind){
    case 1:return GColorChromeYellow; // lights
    case 3:return GColorVividCerulean; // fans
    case 4:return GColorOrange; // covers
    case 5:case 11:return GColorJaegerGreen; // scenes and home scripts
    case 6:return GColorBlueMoon;
    case 7:return GColorPurple;
    case 8:return GColorVividCerulean; // microphone
    case 9:return GColorChromeYellow; // favorites
    case 10:return GColorCyan;
    default:return GColorLightGray;
  }
#else
  return GColorWhite;
#endif
}
static void paint_badge(GContext *ctx,GPoint c,uint8_t kind,bool highlighted){
  graphics_context_set_fill_color(ctx,highlighted?ui_bg():kind_color(kind));
  graphics_fill_circle(ctx,c,14);
  graphics_context_set_stroke_color(ctx,GColorBlack);
  graphics_context_set_fill_color(ctx,GColorBlack);
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
static void draw_cell(GContext *ctx,const Layer *cell,MenuIndex *idx,void *data){
  GRect b=layer_get_bounds(cell);
  bool active=menu_cell_layer_is_highlighted(cell);
  if(!s_visible_count){
    graphics_context_set_text_color(ctx,cell_fg(active));
    graphics_draw_text(ctx,s_loading?"Loading devices...":"No devices to show",
      fonts_get_system_font(FONT_KEY_GOTHIC_18),GRect(8,9,b.size.w-16,42),
      GTextOverflowModeWordWrap,GTextAlignmentCenter,NULL);
    return;
  }
  if(idx->row>=s_visible_count)return;
  ControlRow *r=&s_rows[s_visible[idx->row]];
  int x=PBL_IF_ROUND_ELSE(35,8);
  paint_badge(ctx,GPoint(x+13,b.size.h/2),r->kind,active);
  int left=x+33,wide=b.size.w-left-PBL_IF_ROUND_ELSE(34,8);
  graphics_context_set_text_color(ctx,active?GColorBlack:GColorWhite);
  graphics_draw_text(ctx,r->name,title_font(),
    GRect(left,3,wide-9,title_height()),s_large_text?GTextOverflowModeWordWrap:GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  char subtitle[70];
  snprintf(subtitle,sizeof(subtitle),"%s  |  %s",r->room,r->state);
  graphics_context_set_text_color(ctx,cell_sub(active));
  graphics_draw_text(ctx,subtitle,sub_font(),
    GRect(left,sub_top(),wide,24),GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  if(r->favorite){
    graphics_context_set_text_color(ctx,cell_sub(active));
    graphics_draw_text(ctx,"*",fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
      GRect(b.size.w-PBL_IF_ROUND_ELSE(33,16),4,15,20),
      GTextOverflowModeFill,GTextAlignmentCenter,NULL);
  }
}
static uint16_t num_rows(MenuLayer *m,uint16_t section,void *data){return s_visible_count?s_visible_count:1;}
static int16_t cell_height(MenuLayer *m,MenuIndex *idx,void *data){return s_large_text?86:52;}
static void select_row(MenuLayer *m,MenuIndex *idx,void *data){
  if(idx->row>=s_visible_count)return;
  send_command("CTRL_ACT",s_visible[idx->row]);
  snprintf(s_hint_text,sizeof(s_hint_text),"Sending command...");
  if(s_hint)text_layer_set_text(s_hint,s_hint_text);
}
static void list_load(Window *w){
  GRect b=layer_get_bounds(window_get_root_layer(w));
  window_set_background_color(w,ui_bg());
  s_menu=menu_layer_create(GRect(0,0,b.size.w,b.size.h-20));
  menu_layer_set_callbacks(s_menu,NULL,(MenuLayerCallbacks){
    .get_num_rows=num_rows,.get_cell_height=cell_height,
    .draw_row=draw_cell,.select_click=select_row
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
static void rooms_rebuild(void){
  s_room_count=0;
  for(int i=0;i<s_count;i++){
    int match=-1;
    for(int j=0;j<s_room_count;j++)
      if(strcmp(s_rooms[j],s_rows[i].room)==0){match=j;break;}
    if(match<0&&s_room_count<CONTROL_MAX){
      match=s_room_count++;
      snprintf(s_rooms[match],ROOM_LEN,"%s",s_rows[i].room);
      s_room_sizes[match]=0;
    }
    if(match>=0&&s_room_sizes[match]<255)s_room_sizes[match]++;
  }
  if(s_room_menu)menu_layer_reload_data(s_room_menu);
}
static uint16_t room_rows(MenuLayer *m,uint16_t sec,void *data){
  return s_room_count?s_room_count:1;
}
static void room_draw(GContext *ctx,const Layer *cell,MenuIndex *idx,void *data){
  GRect b=layer_get_bounds(cell);
  if(!s_room_count){
    menu_cell_basic_draw(ctx,cell,s_loading?"Finding rooms...":"No rooms found",
      s_loading?"Reading Home Assistant areas":"Check Bridge settings",NULL);
    return;
  }
  if(idx->row>=s_room_count)return;
  bool active=menu_cell_layer_is_highlighted(cell);
  paint_badge(ctx,GPoint(PBL_IF_ROUND_ELSE(40,22),b.size.h/2),10,active);
  int x=PBL_IF_ROUND_ELSE(61,45);
  graphics_context_set_text_color(ctx,active?GColorBlack:GColorWhite);
  graphics_draw_text(ctx,s_rooms[idx->row],title_font(),
    GRect(x,5,b.size.w-x-7,title_height()),s_large_text?GTextOverflowModeWordWrap:GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  char summary[32];
  snprintf(summary,sizeof(summary),"%d device%s",s_room_sizes[idx->row],
    s_room_sizes[idx->row]==1?"":"s");
  graphics_draw_text(ctx,summary,sub_font(),
    GRect(x,sub_top(),b.size.w-x-7,27),GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
}
static void list_push(void){
  if(s_list)return;
  s_list=window_create();
  window_set_window_handlers(s_list,(WindowHandlers){.load=list_load,.unload=list_unload});
  window_stack_push(s_list,true);
}
static void room_select(MenuLayer *m,MenuIndex *idx,void *data){
  if(idx->row>=s_room_count)return;
  s_visible_count=0;
  for(int i=0;i<s_count;i++){
    if(strcmp(s_rows[i].room,s_rooms[idx->row])==0)
      s_visible[s_visible_count++]=(uint8_t)i;
  }
  snprintf(s_hint_text,sizeof(s_hint_text),"%s",s_rooms[idx->row]);
  list_push();
}
static void room_load(Window *w){
  GRect b=layer_get_bounds(window_get_root_layer(w));
  window_set_background_color(w,ui_bg());
  s_room_menu=menu_layer_create(b);
  menu_layer_set_callbacks(s_room_menu,NULL,(MenuLayerCallbacks){
    .get_num_rows=room_rows,.get_cell_height=cell_height,
    .draw_row=room_draw,.select_click=room_select
  });
  menu_layer_set_normal_colors(s_room_menu,ui_bg(),ui_fg());
  menu_layer_set_highlight_colors(s_room_menu,ui_selected_bg(),ui_selected_fg());
#ifdef PBL_ROUND
  menu_layer_set_center_focused(s_room_menu,true);
#endif
  menu_layer_set_click_config_onto_window(s_room_menu,w);
  layer_add_child(window_get_root_layer(w),menu_layer_get_layer(s_room_menu));
}
static void room_unload(Window *w){
  menu_layer_destroy(s_room_menu);s_room_menu=NULL;
  window_destroy(s_room_window);s_room_window=NULL;
}
void controls_open_mode(int mode){
  if(s_list||s_room_window)return;
  s_mode=mode;s_count=0;s_visible_count=0;s_room_count=0;s_loading=true;
  if(mode==0){
    s_room_window=window_create();
    window_set_window_handlers(s_room_window,(WindowHandlers){.load=room_load,.unload=room_unload});
    window_stack_push(s_room_window,true);
  }else{
    snprintf(s_hint_text,sizeof(s_hint_text),"%s",mode==1?"Favorite devices":"Scenes and scripts");
    list_push();
  }
  send_command("CTRL_REQUEST",mode);
}
// Legacy entry point used by earlier code.
void controls_open(void){controls_open_mode(0);}
void controls_start_voice(void);
static void home_back_handler(ClickRecognizerRef recognizer,void *context){
  window_stack_pop_all(true);
}
static const char *home_names[]={"Voice Assistant","Favorites","Devices by Room","Scenes & Scripts"};
static const char *home_subs[]={"Dictation and conversation","Your pinned controls","Browse Home Assistant","Run saved actions"};
static void home_draw(GContext *ctx,const Layer *cell,MenuIndex *idx,void *data){
  GRect b=layer_get_bounds(cell);
  bool active=menu_cell_layer_is_highlighted(cell);
  paint_badge(ctx,GPoint(PBL_IF_ROUND_ELSE(40,20),b.size.h/2),(uint8_t)(idx->row+8),active);
  int x=PBL_IF_ROUND_ELSE(60,39);
  graphics_context_set_text_color(ctx,active?GColorBlack:GColorWhite);
  graphics_draw_text(ctx,home_names[idx->row],title_font(),
    GRect(x,4,b.size.w-x-7,title_height()),s_large_text?GTextOverflowModeWordWrap:GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  graphics_context_set_text_color(ctx,active?GColorBlack:PBL_IF_COLOR_ELSE(GColorLightGray,GColorWhite));
  if(!s_large_text)graphics_draw_text(ctx,home_subs[idx->row],sub_font(),
    GRect(x,sub_top(),b.size.w-x-7,27),GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
}
static uint16_t home_rows(MenuLayer *m,uint16_t sec,void *ctx){return 4;}
static void home_select(MenuLayer *m,MenuIndex *idx,void *ctx){
  switch(idx->row){
    case 0:window_stack_pop(true);controls_start_voice();break;
    case 1:controls_open_mode(1);break;
    case 2:controls_open_mode(0);break;
    case 3:controls_open_mode(2);break;
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
  if(s_home)return;
  s_home=window_create();
  window_set_window_handlers(s_home,(WindowHandlers){.load=home_load,.unload=home_unload});
  window_stack_push(s_home,true);
}
void controls_receive(DictionaryIterator *iter,const char *command){
  if(strcmp(command,"CTRL_ROW")==0){
    Tuple *i=dict_find(iter,MESSAGE_KEY_CTRL_INDEX);
    Tuple *n=dict_find(iter,MESSAGE_KEY_CTRL_NAME);
    Tuple *s=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    Tuple *id=dict_find(iter,MESSAGE_KEY_CTRL_ID);
    Tuple *room=dict_find(iter,MESSAGE_KEY_CTRL_ROOM);
    Tuple *kind=dict_find(iter,MESSAGE_KEY_CTRL_KIND);
    Tuple *fav=dict_find(iter,MESSAGE_KEY_CTRL_FAV);
    if(!i||!n||!s||!id)return;
    int index=i->value->int32;
    if(index<0||index>=CONTROL_MAX)return;
    snprintf(s_rows[index].name,sizeof(s_rows[index].name),"%s",n->value->cstring);
    snprintf(s_rows[index].state,sizeof(s_rows[index].state),"%s",s->value->cstring);
    snprintf(s_rows[index].id,sizeof(s_rows[index].id),"%s",id->value->cstring);
    snprintf(s_rows[index].room,sizeof(s_rows[index].room),"%s",room?room->value->cstring:"Unassigned");
    s_rows[index].kind=kind?(uint8_t)kind->value->int32:0;
    s_rows[index].favorite=fav?fav->value->int32!=0:false;
    if(index>=s_count)s_count=index+1;
    s_loading=false;
    if(s_mode!=0){
      s_visible_count=s_count;
      for(int n=0;n<s_visible_count;n++)s_visible[n]=(uint8_t)n;
      if(s_menu)menu_layer_reload_data(s_menu);
    }
  } else if(strcmp(command,"CTRL_DONE")==0){
    s_loading=false;
    if(s_mode==0)rooms_rebuild();
    if(s_menu)menu_layer_reload_data(s_menu);
    if(s_hint)text_layer_set_text(s_hint,"Select: toggle or run");
  } else if(strcmp(command,"CTRL_ERROR")==0){
    s_loading=false;
    Tuple *t=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    snprintf(s_hint_text,sizeof(s_hint_text),"%s",t?t->value->cstring:"Control failed");
    if(s_hint)text_layer_set_text(s_hint,s_hint_text);
    if(s_menu)menu_layer_reload_data(s_menu);
    if(s_room_menu)menu_layer_reload_data(s_room_menu);
  }
}
