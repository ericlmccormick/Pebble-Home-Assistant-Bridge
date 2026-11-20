'use strict';
const assert=require('assert');
const fs=require('fs');
const c=fs.readFileSync('src/c/ha_controls.c','utf8');
const voice=fs.readFileSync('src/c/main.c','utf8');
const src=(a,b)=>{const i=c.indexOf(a),j=c.indexOf(b,i+a.length);assert(i>=0&&j>i);return c.slice(i,j);};
assert(c.includes('static int row_height(void){return s_large_text?62:46;}'),
 'Large text home rows are 62 px, not former 80 px');
const draw=src('static void home_draw(','static uint16_t home_rows(');
assert(draw.includes('int title_y=s_large_text?(b.size.h-title_h)/2-2:home_title_top();'),
 'Title is centered vertically with icon and two-line label allowance');
const click=src('static void home_select(','static void home_up_click(');
assert(click.includes('case 0:window_stack_pop(false);controls_start_voice();break;'),
 'Voice Assistant skips the animated idle screen');
assert(!voice.includes('app_timer_register(300,voice_begin_after_navigation'),
 'Voice dictation is not delayed by the former 300 ms timer');
assert(voice.includes('select_short_click_handler(NULL,NULL);'),
 'Voice shortcut opens PebbleOS dictation directly');
const load=src('static void list_load(','static void list_unload(');
assert(load.includes('scroll_layer_set_content_offset(menu_layer_get_scroll_layer(s_menu),GPoint(0,0),false);'),
 'Rooms begin scrolled to actual top so first heading remains visible');
const done=src('if(strcmp(command,"CTRL_DONE")==0){','if(strcmp(command,"CTRL_ACTION_DONE")==0){');
assert(done.includes('if(s_mode==0&&s_page_offset==0)'),
 'First room heading remains visible after catalog reload');
console.log('Compact large home text, instant voice navigation, and first room heading positioning passed');
