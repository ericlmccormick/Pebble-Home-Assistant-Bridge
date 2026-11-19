#include <pebble.h>
#include <stdio.h>
#include <string.h>
// Native quick-control list, deliberately isolated from the voice/audio state machine.
#define CONTROL_MAX 48
typedef struct { char id[64], name[48], state[28]; } ControlRow;
static ControlRow rows[CONTROL_MAX];
static int row_count=0;
static Window *control_window=NULL;
static MenuLayer *control_menu=NULL;
static TextLayer *control_hint=NULL;
static bool loading=false;
static void control_send(const char *command, int index) {
  DictionaryIterator *out=NULL;
  if(app_message_outbox_begin(&out)!=APP_MSG_OK || !out)return;
  dict_write_cstring(out,MESSAGE_KEY_COMMAND,command);
  if(index>=0)dict_write_int32(out,MESSAGE_KEY_CTRL_INDEX,index);
  dict_write_end(out);
  app_message_outbox_send();
}
static uint16_t count_rows(MenuLayer *m,uint16_t section,void *ctx){return row_count?row_count:1;}
static void draw_row(GContext *ctx,const Layer *cell,MenuIndex *idx,void *data){
  if(!row_count){menu_cell_basic_draw(ctx,cell,loading?"Loading devices...":"No devices found", "Check Bridge connection",NULL);return;}
  ControlRow *r=&rows[idx->row];
  menu_cell_basic_draw(ctx,cell,r->name,r->state,NULL);
}
static void activate(MenuLayer *m,MenuIndex *idx,void *ctx){
  if(idx->row>=row_count)return;
  control_send("CTRL_ACT",idx->row);
  if(control_hint)text_layer_set_text(control_hint,"Sending...");
}
static void on_load(Window *w){
  GRect bounds=layer_get_bounds(window_get_root_layer(w));
  control_menu=menu_layer_create(GRect(0,0,bounds.size.w,bounds.size.h-24));
  menu_layer_set_callbacks(control_menu,NULL,(MenuLayerCallbacks){
    .get_num_rows=count_rows,.draw_row=draw_row,.select_click=activate
  });
  menu_layer_set_click_config_onto_window(control_menu,w);
  layer_add_child(window_get_root_layer(w),menu_layer_get_layer(control_menu));
  control_hint=text_layer_create(GRect(0,bounds.size.h-24,bounds.size.w,24));
  text_layer_set_text_alignment(control_hint,GTextAlignmentCenter);
  text_layer_set_font(control_hint,fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text(control_hint,"Select: toggle / run");
  layer_add_child(window_get_root_layer(w),text_layer_get_layer(control_hint));
}
static void on_unload(Window *w){
  menu_layer_destroy(control_menu);control_menu=NULL;
  text_layer_destroy(control_hint);control_hint=NULL;
  window_destroy(control_window);control_window=NULL;
}
void controls_open(void){
  if(control_window)return;
  row_count=0;loading=true;
  control_window=window_create();
  window_set_window_handlers(control_window,(WindowHandlers){.load=on_load,.unload=on_unload});
  window_stack_push(control_window,true);
  control_send("CTRL_REQUEST",-1);
}
void controls_receive(DictionaryIterator *iter,const char *command){
  if(strcmp(command,"CTRL_ROW")==0){
    Tuple *i=dict_find(iter,MESSAGE_KEY_CTRL_INDEX);
    Tuple *n=dict_find(iter,MESSAGE_KEY_CTRL_NAME);
    Tuple *s=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    Tuple *id=dict_find(iter,MESSAGE_KEY_CTRL_ID);
    if(!i||!n||!s||!id)return;
    int index=i->value->int32;
    if(index<0||index>=CONTROL_MAX)return;
    snprintf(rows[index].name,sizeof(rows[index].name),"%s",n->value->cstring);
    snprintf(rows[index].state,sizeof(rows[index].state),"%s",s->value->cstring);
    snprintf(rows[index].id,sizeof(rows[index].id),"%s",id->value->cstring);
    if(index>=row_count)row_count=index+1;
    loading=false;
    if(control_menu)menu_layer_reload_data(control_menu);
  } else if(strcmp(command,"CTRL_DONE")==0){
    loading=false;
    if(control_menu)menu_layer_reload_data(control_menu);
    if(control_hint)text_layer_set_text(control_hint,"Select: toggle / run");
  } else if(strcmp(command,"CTRL_ERROR")==0){
    loading=false;
    Tuple *t=dict_find(iter,MESSAGE_KEY_CTRL_STATUS);
    if(control_hint)text_layer_set_text(control_hint,t?t->value->cstring:"Control failed");
    if(control_menu)menu_layer_reload_data(control_menu);
  }
}
