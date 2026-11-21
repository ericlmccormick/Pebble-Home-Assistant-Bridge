'use strict';
const assert=require('assert'),fs=require('fs');
const c=fs.readFileSync('src/c/ha_controls.c','utf8');
const js=fs.readFileSync('src/pkjs/index.js','utf8');
assert(c.includes('graphics_text_layout_get_content_size('),
 'Large text positions from measured text bounds');
assert(c.includes('GRect home_label=s_large_text?aligned_row_text('),
 'Home menu text uses measured vertical alignment');
assert(c.includes('GRect(left,s_large_text?-3:0,width,s_large_text?34:25)'),
 'Device name starts high in both Normal and Large layouts');
assert(c.includes('device_status_box(r,b.size.w),GTextOverflowModeWordWrap'),
 'Device state is placed directly beneath the name without overlap');
assert(c.includes('GTextOverflowModeTrailingEllipsis,GTextAlignmentLeft,NULL);'),
 'Long device names truncate rather than overlapping the status');
assert(js.includes("if(domain==='lock')return 13"));
assert(js.includes("if(domain==='cover'&&/(garage|door)/i.test("));
assert(c.includes('case 13: // front door lock'));
assert(c.includes('case 14: // garage door'));
assert(c.includes('s_detail_secure=s_rows[index].kind==4||s_rows[index].kind==13||s_rows[index].kind==14'),
 'Sensitive controls require the detail view');
const detail=c.slice(c.indexOf('static void detail_select_click('),c.indexOf('static void detail_click_config('));
assert(detail.includes('if(!s_detail_armed)')&&detail.includes('s_detail_armed=true'),
 'First Select arms only');
assert(detail.includes('send_command("CTRL_SECURE_ACT",s_detail_index)'),
 'Only subsequent Select submits the secure command');
assert(!detail.includes('send_command("CTRL_ACT",s_detail_index))\n    s_detail_busy'),
 'No immediate generic toggle on secure entities');
assert(js.includes("pluginAction('secure_control',{entity_id:item.id})"),
 'Secure action uses separate Bridge permissioned handler');
assert(js.includes("if(meta.adjustable||item.row.domain==='lock'||item.row.domain==='cover')"),
 'Secure entities show detail instead of toggling in the list');
console.log('Measured large-font positioning and confirmed door/lock controls passed');
