'use strict';
const assert=require('assert'),fs=require('fs');
const C=fs.readFileSync('src/c/ha_controls.c','utf8');
const VOICE=fs.readFileSync('src/c/main.c','utf8');
const JS=fs.readFileSync('src/pkjs/index.js','utf8');
const manifest=require('../package.json');
assert(C.includes('"Voice Assistant","Favorites","Devices by Room","Scenes & Scripts","Settings"'));
assert(C.includes('static uint16_t home_rows(')&&C.includes('return 5;'));
assert(C.includes('case 4:settings_open();break;'));
for(const name of ['Theme','Text size','Voice volume','Force recheck'])
  assert(C.includes('"'+name+'"'));
assert(C.includes('static void settings_load('));
assert(C.includes('menu_layer_set_click_config_onto_window(s_settings_menu,w)'));
assert(C.includes('static void volume_settings_clicks(')&&
  C.includes('window_single_click_subscribe(BUTTON_ID_UP,volume_settings_up)')&&
  C.includes('window_single_click_subscribe(BUTTON_ID_DOWN,volume_settings_down)'));
assert(VOICE.includes('persist_write_int(PERSIST_KEY_VOLUME,pct)')&&
  VOICE.includes('ha_audio_set_volume(s_volume)'));
assert(JS.includes("d.COMMAND==='CTRL_THEME_SET'")&&JS.includes("d.COMMAND==='CTRL_FONT_SET'"));
assert(JS.includes('THEME_MODE_CODE:themeMode')&&manifest.pebble.messageKeys.includes('THEME_MODE_CODE'));
assert(JS.includes("function forceRefreshControls()"));
assert(JS.includes("fetchControlsIfStale(true)"));
assert(JS.includes("d.COMMAND==='CTRL_FORCE_REFRESH'"));
assert(JS.includes("function controlInspect(index)"));
assert(JS.includes("d.COMMAND==='CTRL_INSPECT'"));
assert(JS.includes("pluginAction('get_state',{entity_id:item.id})"));
assert(JS.includes('metadata_only:true'));
assert(JS.includes("CTRL_GRAND_TOTAL:total"));
assert(JS.includes("CTRL_HAS_MORE:offset+controlRows.length<total?1:0"));
assert(!JS.includes('.slice(0,48)'));
assert(!C.includes('CONTROL_MAX 48'));
assert(C.includes('static void cache_schema_migrate(void)'));
console.log('On-watch settings, full device refresh and paging protocol contracts passed');
