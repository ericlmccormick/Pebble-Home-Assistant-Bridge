'use strict';
const assert=require('assert'),fs=require('fs');
const c=fs.readFileSync('src/c/ha_controls.c','utf8');
const js=fs.readFileSync('src/pkjs/index.js','utf8');
assert(c.includes('int y=slot.origin.y+(slot.size.h-h)/2;'),
 'Main menu font must not have extra downward offset');
assert(!c.includes('int y=slot.origin.y+(slot.size.h-h)/2+4;'));
const draw=c.slice(c.indexOf('static void draw_cell('),c.indexOf('// A single row is below',c.indexOf('static void draw_cell(')));
assert(draw.includes('GRect(left,s_large_text?-3:0,width,s_large_text?34:25)'),
 'Large title is positioned higher');
assert(draw.includes('device_status_box(r,b.size.w),GTextOverflowModeWordWrap'),
 'The status occupies a separate, wrapped band');
assert(c.includes('int bottom=status.origin.y+status.size.h+2;'),
 'Device rows grow to display the measured status');
assert(draw.includes('r->subtitle[0]?r->subtitle:'),'Status is read from live subtitle');
assert(js.includes('CTRL_SUBTITLE:deviceStatusSubtitle(row,fresh)'));
const done=c.slice(c.indexOf('if(strcmp(command,"CTRL_DONE")==0){'),c.indexOf('if(strcmp(command,"CTRL_ACTION_DONE")==0){'));
assert(done.includes('if(!catalog_store())'));
assert(!done.includes('s_catalog_revision=0;'),
 'Catalog storage failure cannot discard the live page revision');
const receive=c.slice(c.indexOf('if(strcmp(command,"CTRL_STATE")==0){'),c.indexOf('if(strcmp(command,"CTRL_DONE")==0){'));
assert(receive.includes('rev->value->int32!=s_catalog_revision'));
assert(receive.includes('s_rows[index].subtitle'));
assert(receive.includes('menu_layer_reload_data(s_menu)'));
console.log('Large font baseline, visible status subtitle, and nonpersistent live revision passed');
