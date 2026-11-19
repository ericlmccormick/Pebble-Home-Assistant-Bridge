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
static int s_count=0, s_mode=0; // 0: all; 1: favorites; 2: scenes and scripts
static bool s_loading=false;
static Window *s_home=NULL,*s_list=NULL;
static MenuLayer *s_home_menu=NULL,*s_menu=NULL;
static TextLayer *s_hint=NULL;
static char s_hint_text[64]="Select: toggle or run";

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
  graphics_context_set_fill_color(ctx,highlighted?GColorWhite:kind_color(kind));
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
  if(!s_count){
    graphics_context_set_text_color(ctx,active?GColorBlack:GColorWhite);
    graphics_draw_text(ctx,s_loading?"Loading devices...":"No devices to show",
      fonts_get_system_font(FONT_KEY_GOTHIC_18),GRect(8,9,b.size.w-16,42),
      GTextOverflowModeWordWrap,GTextAlignmentCenter,NULL);
    return;
  }
  if(idx->row>=s_count)return;
  ControlRow *r=&s_rows[idx->row];
  int x=PBL_IF_ROUND_ELSE(35,8);
  paint_badge(ctx,GPoint(x+13,b.size.h/2),r->kind,active);
  int left=x+33,wide=b.size.w-left-PBL_IF_ROUND_ELSE(34,8);
  graphics_context_set_text_color(ctx,active?GColorBlack:GColorWhite);
  graphics_draw_text(ctx,r->name,fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
    GRect(left,3,wide-9,24),GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  char subtitle[70];
  snprintf(subtitle,sizeof(subtitle),"%s  |  %s",r->room,r->state);
  graphics_context_set_text_color(ctx,active?GColorBlack:PBL_IF_COLOR_ELSE(GColorLightGray,GColorWhite));
  graphics_draw_text(ctx,subtitle,fonts_get_system_font(FONT_KEY_GOTHIC_14),
    GRect(left,26,wide,22),GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  if(r->favorite){
    graphics_context_set_text_color(ctx,active?GColorBlack:PBL_IF_COLOR_ELSE(GColorChromeYellow,GColorWhite));
    graphics_draw_text(ctx,"*",fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
      GRect(b.size.w-PBL_IF_ROUND_ELSE(33,16),4,15,20),
      GTextOverflowModeFill,GTextAlignmentCenter,NULL);
  }
}
static uint16_t num_rows(MenuLayer *m,uint16_t section,void *data){return s_count?s_count:1;}
static int16_t cell_height(MenuLayer *m,MenuIndex *idx,void *data){return 52;}
static void select_row(MenuLayer *m,MenuIndex *idx,void *data){
  if(idx->row>=s_count)return;
  send_command("CTRL_ACT",idx->row);
  snprintf(s_hint_text,sizeof(s_hint_text),"Sending command...");
  if(s_hint)text_layer_set_text(s_hint,s_hint_text);
}
static void list_load(Window *w){
  GRect b=layer_get_bounds(window_get_root_layer(w));
  window_set_background_color(w,GColorBlack);
  s_menu=menu_layer_create(GRect(0,0,b.size.w,b.size.h-20));
  menu_layer_set_callbacks(s_menu,NULL,(MenuLayerCallbacks){
    .get_num_rows=num_rows,.get_cell_height=cell_height,
    .draw_row=draw_cell,.select_click=select_row
  });
  menu_layer_set_normal_colors(s_menu,GColorBlack,GColorWhite);
  menu_layer_set_highlight_colors(s_menu,PBL_IF_COLOR_ELSE(GColorVividCerulean,GColorWhite),GColorBlack);
#ifdef PBL_ROUND
  menu_layer_set_center_focused(s_menu,true);
#endif
  menu_layer_set_click_config_onto_window(s_menu,w);
  layer_add_child(window_get_root_layer(w),menu_layer_get_layer(s_menu));
  s_hint=text_layer_create(GRect(0,b.size.h-20,b.size.w,20));
  text_layer_set_background_color(s_hint,GColorBlack);
  text_layer_set_text_color(s_hint,GColorWhite);
  text_layer_set_font(s_hint,fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_hint,GTextAlignmentCenter);
  text_layer_set_text(s_hint,s_hint_text);
  layer_add_child(window_get_root_layer(w),text_layer_get_layer(s_hint));
}
static void list_unload(Window *w){
  menu_layer_destroy(s_menu);s_menu=NULL;
  text_layer_destroy(s_hint);s_hint=NULL;
  window_destroy(s_list);s_list=NULL;
}
void controls_open_mode(int mode){
  if(s_list)return;
  s_mode=mode;s_count=0;s_loading=true;
  snprintf(s_hint_text,sizeof(s_hint_text),"%s",mode==1?"Favorite devices":mode==2?"Scenes and scripts":"Select: toggle or run");
  s_list=window_create();
  window_set_window_handlers(s_list,(WindowHandlers){.load=list_load,.unload=list_unload});
  window_stack_push(s_list,true);
  send_command("CTRL_REQUEST",mode);
}
// Legacy entry point used by earlier code.
void controls_open(void){controls_open_mode(0);}
static const char *home_names[]={"Voice Assistant","Favorites","Devices by Room","Scenes & Scripts"};
static const char *home_subs[]={"Dictation and conversation","Your pinned controls","Browse Home Assistant","Run saved actions"};
static void home_draw(GContext *ctx,const Layer *cell,MenuIndex *idx,void *data){
  GRect b=layer_get_bounds(cell);
  bool active=menu_cell_layer_is_highlighted(cell);
  paint_badge(ctx,GPoint(PBL_IF_ROUND_ELSE(40,20),b.size.h/2),(uint8_t)(idx->row+8),active);
  int x=PBL_IF_ROUND_ELSE(60,39);
  graphics_context_set_text_color(ctx,active?GColorBlack:GColorWhite);
  graphics_draw_text(ctx,home_names[idx->row],fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
    GRect(x,4,b.size.w-x-7,23),GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
  graphics_context_set_text_color(ctx,active?GColorBlack:PBL_IF_COLOR_ELSE(GColorLightGray,GColorWhite));
  graphics_draw_text(ctx,home_subs[idx->row],fonts_get_system_font(FONT_KEY_GOTHIC_14),
    GRect(x,26,b.size.w-x-7,22),GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);
}
static uint16_t home_rows(MenuLayer *m,uint16_t sec,void *ctx){return 4;}
static void home_select(MenuLayer *m,MenuIndex *idx,void *ctx){
  switch(idx->row){
    case 0:window_stack_pop(true);break;
    case 1:controls_open_mode(1);break;
    case 2:controls_open_mode(0);break;
    case 3:controls_open_mode(2);break;
  }
}
static void home_load(Window *w){
  GRect b=layer_get_bounds(window_get_root_layer(w));
  window_set_background_color(w,GColorBlack);
  s_home_menu=menu_layer_create(b);
  menu_layer_set_callbacks(s_home_menu,NULL,(MenuLayerCallbacks){
    .get_num_rows=home_rows,.get_cell_height=cell_height,
    .draw_row=home_draw,.select_click=home_select
  });
  menu_layer_set_normal_colors(s_home_menu,GColorBlack,GColorWhite);
  menu_layer_set_highlight_colors(s_home_menu,PBL_IF_COLOR_ELSE(GColorVividCerulean,GColorWhite),GColorBlack);
#ifdef PBL_ROUND
  menu_layer_set_center_focused(s_home_menu,true);
#endif
  menu_layer_set_click_config_onto_window(s_home_menu,w);
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
    if(s_menu)menu_layer_reload_data(s_menu);
  } else if(strcmp(command,"CTRL_DONE")==0){
    s_loading=false;
    if(s_menu)menu_layer_reload_data(s_menu);
    if(s_hint)text_layer_set_text(s_hint,"Select: toggle or run");
  } else if(strcmp(command,"CTRL_ERROR")==0){
    s_loading=false;
    Tuple *t=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    snprintf(s_hint_text,sizeof(s_hint_text),"%s",t?t->value->cstring:"Control failed");
    if(s_hint)text_layer_set_text(s_hint,s_hint_text);
    if(s_menu)menu_layer_reload_data(s_menu);
  }
}
