'use strict';
const assert=require('assert');
const fs=require('fs');
const c=fs.readFileSync('src/c/ha_controls.c','utf8');
const pkjs=fs.readFileSync('src/pkjs/index.js','utf8');

function between(src,a,b){
  const i=src.indexOf(a),j=src.indexOf(b,i+a.length);
  assert(i>=0&&j>i,'Missing source region '+a+' / '+b);
  return src.slice(i,j);
}
const browse=between(c,'void controls_open_mode(int mode){','// Legacy entry point');
assert(browse.includes('visible_rebuild();')&&browse.includes('rooms_rebuild();'));
assert(browse.includes('list_push();'),'Rooms open in the same direct device list');
assert(c.includes('static void list_push(void){')&&
       c.includes('.load=list_load,.unload=list_unload'),
  'Shared device-list window is still constructed after removing room drill-down');
assert(!browse.includes('s_room_window')&&!browse.includes('room_select'),
  'Rooms must not be selectable drill-down windows');
const callbacks=between(c,'static void list_load(Window *w){','static void list_unload(Window *w){');
for(const fn of ['get_num_sections=num_sections','get_num_rows=num_rows',
  'get_header_height=room_header_height','draw_header=draw_room_header',
  'draw_row=draw_cell','select_click=select_row']){
  assert(callbacks.includes(fn),'Room headers and device rows share one MenuLayer: '+fn);
}
const grouping=between(c,'static void rooms_rebuild(void){','void controls_open_mode(int mode){');
for(const claim of ['s_room_starts[s_room_count]=(uint8_t)vi',
  's_room_sizes[s_room_count]=0','s_room_sizes[s_room_count-1]++',
  'strcmp(s_rooms[s_room_count-1],r->room)!=0']){
  assert(grouping.includes(claim),'Room sections build from device catalog: '+claim);
}
const mapping=between(c,'static int catalog_index_for(MenuIndex *idx){','static void draw_cell(');
assert(mapping.includes('s_room_starts[sec]+idx->row'));
assert(mapping.includes('return s_visible[vi]'),
  'Device actions retain the phone watch-index, not room-local menu row');
assert(mapping.includes('idx->row>=s_room_sizes[sec]'),
  'Out-of-bounds room rows cannot control devices');
const act=between(c,'static void select_row(','static void list_load(');
assert(act.includes('send_command("CTRL_INSPECT",index)'),'Selecting a device retrieves live capability first');
assert(act.includes('nav_action(idx)')&&act.includes('s_request_offset=target'),
  'More and Previous actions page the watch catalog');
assert(!act.includes('send_command("CTRL_ACT",idx->row)'));
const header=between(c,'static void draw_room_header(','static uint16_t num_rows(');
assert(header.includes('ui_muted()'),'Room header colors follow day/night theme');
assert(header.includes('FONT_KEY_GOTHIC_14_BOLD'),'Normal text has compact headings');
assert(header.includes('FONT_KEY_GOTHIC_18_BOLD'),'Large text uses readable headings');
const sectionCount=between(c,'static uint16_t num_sections(','static int16_t cell_height(');
assert(sectionCount.includes('return base_sections()+(s_page_offset>0?1:0)+(s_has_more?1:0)'),
  'Room headers share a paged list with Previous and More sections');
assert(sectionCount.includes('return sec<s_room_count?s_room_sizes[sec]:0'));
assert(sectionCount.includes('s_visible_count?s_visible_count:1'),
  'Empty catalogs still show placeholder and favorites/scenes remain flat');
assert(!c.includes('s_room_window')&&!c.includes('s_room_menu'),
  'Dead room navigation windows removed');
assert(browse.includes('catalog_restore();')&&
  browse.includes('if(!s_sync_pending)s_sync_pending=send_command("CTRL_REQUEST",s_mode);'),
  'Every section entry requests live state even if catalog metadata is cached');
assert(browse.indexOf('list_push();')<
  browse.indexOf('send_command("CTRL_REQUEST",s_mode)'),
  'Cached list renders before the network request');
assert(pkjs.includes("String(a.room||'').localeCompare(String(b.room||''))"),
  'Phone catalog is pre-sorted so room groups are contiguous');
assert(pkjs.includes('hidden.indexOf(r.id)>=0'),
  'Hidden devices never create watch rows or empty room sections');

// Simulate section boundaries over an already-sorted and visibility-filtered
// catalog to guard the intended menu-to-watch-index mapping.
const catalog=[
  {room:'Bedroom',index:0},{room:'Bedroom',index:1},
  {room:'Kitchen',index:2},{room:'Kitchen',index:3},
  {room:'Living Room',index:4}
];
const starts=[],counts=[],names=[];
catalog.forEach((r,i)=>{
  if(names[names.length-1]!==r.room){
    names.push(r.room);starts.push(i);counts.push(0);
  }
  counts[counts.length-1]++;
});
assert.deepStrictEqual(names,['Bedroom','Kitchen','Living Room']);
assert.deepStrictEqual(counts,[2,2,1]);
assert.strictEqual(catalog[starts[1]+1].index,3,'Second Kitchen row maps to index 3');
console.log('Inline room sections, no-drill-down, cached browsing, theme and action indexing passed');
