'use strict';
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const C=fs.readFileSync('src/c/ha_controls.c','utf8');
const VOICE=fs.readFileSync('src/c/main.c','utf8');
const JS=fs.readFileSync('src/pkjs/index.js','utf8');
const manifest=require('../package.json');
const memory={};
const actions=[],messages=[],handlers={},configurations=[];
const states=[];
for(let i=0;i<55;i++)states.push({
  id:'switch.generic_'+i,name:'Switch '+i,room:'Living',domain:'switch',state:'off',advanced:false
});
states.push({id:'fan.attic',name:'Attic Fan',room:'Attic',domain:'fan',state:'on',advanced:true});
states.push({id:'switch.house_fan',name:'Whole house fan',room:'Entry',domain:'switch',state:'off',advanced:false});
const storage={
  getItem:k=>Object.prototype.hasOwnProperty.call(memory,k)?memory[k]:null,
  setItem:(k,v)=>{memory[k]=String(v);},
  removeItem:k=>{delete memory[k];}
};
const Pebble={
  addEventListener:(ev,fn)=>{handlers[ev]=fn;},
  getActiveWatchInfo:()=>({platform:'emery'}),
  openURL:()=>{},
  sendAppMessage:(msg,ok)=>{messages.push(msg);if(ok)ok();},
  invokeAction:({action,args})=>{
    actions.push({action,args});
    if(action==='list_controls')return Promise.resolve({
      ok:true,text:JSON.stringify(states.slice(Number(args.offset)||0,(Number(args.offset)||0)+48))
    });
    throw Error('Unexpected action: '+action);
  }
};
function Clay(config){configurations.push(config);this.generateUrl=()=> 'pebble://settings';}
const audio={diagnostics:()=>null,handleMessage:()=>false,stop:()=>{},speak:()=>Promise.resolve()};
const context={Pebble,localStorage:storage,Date,JSON,Math,Number,String,Promise,
  console,setInterval:()=>0,setTimeout:()=>0,
  require:n=>n==='pebble-clay'?Clay:n==='./ha_audio'?{create:()=>audio}:
    (()=>{throw Error('Unexpected module '+n);})()};
vm.runInNewContext(JS,context,{filename:'index.js'});
const send=(m)=>handlers.appmessage({payload:m});
async function settle(){for(let n=0;n<15;n++)await new Promise(resolve=>setImmediate(resolve));}

(async()=>{
  assert(manifest.pebble.messageKeys.includes('THEME_MODE_CODE'));
  assert(C.includes('"Voice Assistant","Favorites","Devices by Room","Scenes & Scripts","Settings"'));
  assert(C.includes('static uint16_t home_rows(')&&C.includes('return 5;'),
    'Settings is fifth and final home item');
  assert(C.includes('case 4:settings_open();break;'));
  for(const name of ['Theme','Text size','Voice volume','Force recheck'])
    assert(C.includes('"'+name+'"'),'Native watch setting exists: '+name);
  assert(C.includes('static void settings_load('));
  assert(C.includes('menu_layer_set_click_config_onto_window(s_settings_menu,w)'),
    'Settings must use a valid click provider');
  assert(C.includes('static void volume_settings_clicks(')&&
    C.includes('window_single_click_subscribe(BUTTON_ID_UP,volume_settings_up)')&&
    C.includes('window_single_click_subscribe(BUTTON_ID_DOWN,volume_settings_down)'),
    'Up/Down must adjust existing speaker volume');
  assert(VOICE.includes('persist_write_int(PERSIST_KEY_VOLUME,pct)')&&
    VOICE.includes('ha_audio_set_volume(s_volume)'),
    'Volume is persisted and routed through the existing audio mixer');

  send({COMMAND:'CTRL_REQUEST',CTRL_REV:0});
  await settle();
  const baseCalls=actions.filter(x=>x.action==='list_controls').length;
  assert(baseCalls===2,'Discover fan beyond first 48 entities');
  assert(messages.some(x=>x.COMMAND==='CTRL_ROW'&&x.CTRL_NAME==='Attic Fan'&&x.CTRL_KIND===3));
  assert(messages.some(x=>x.COMMAND==='CTRL_ROW'&&x.CTRL_NAME==='Whole house fan'&&x.CTRL_KIND===3),
    'Switch-backed fans get fan icons');
  const initialRows=messages.filter(x=>x.COMMAND==='CTRL_ROW').length;
  assert.strictEqual(initialRows,48,'Watch still sends only bounded 48 entities');
  const rev=messages.find(x=>x.COMMAND==='CTRL_DONE').CTRL_REV;
  messages.length=0;
  send({COMMAND:'CTRL_REQUEST',CTRL_REV:rev});
  await settle();
  assert.strictEqual(actions.filter(x=>x.action==='list_controls').length,baseCalls,
    'Normal revisit uses the cache without another plugin action');
  assert.strictEqual(messages.filter(x=>x.COMMAND==='CTRL_ROW').length,0,
    'Unchanged metadata is not re-sent');

  messages.length=0;
  send({COMMAND:'CTRL_FORCE_REFRESH'});
  await settle();
  assert(actions.filter(x=>x.action==='list_controls').length>baseCalls,
    'Force recheck MUST run a new Bridge discovery now');
  assert.strictEqual(messages.filter(x=>x.COMMAND==='CTRL_ROW').length,48,
    'Forced discovery retransmits the full catalog immediately');
  assert(messages.some(x=>x.COMMAND==='CTRL_DONE'));
  assert(Number(memory.HA_CONTROLS_FETCHED_AT_V2)>0);

  messages.length=0;
  send({COMMAND:'CTRL_THEME_SET',CTRL_INDEX:1});
  await settle();
  assert.strictEqual(memory.HA_THEME_MODE,'night');
  assert(messages.some(x=>x.COMMAND==='SETTINGS'&&
    x.THEME_MODE_CODE===1&&x.THEME_DARK===1));
  send({COMMAND:'CTRL_THEME_SET',CTRL_INDEX:2});
  assert.strictEqual(memory.HA_THEME_MODE,'auto');
  send({COMMAND:'CTRL_FONT_SET',CTRL_INDEX:1});
  assert.strictEqual(memory.FONT_CHOICE,'large');
  assert(messages.some(x=>x.COMMAND==='SETTINGS'&&x.LARGE_TEXT===1));

  handlers.showConfiguration();
  assert(configurations.length>0);
  const prior=actions.length;
  handlers.webviewclosed({response:encodeURIComponent(JSON.stringify({
    REFRESH_DEVICES:{value:true}
  }))});
  await settle();
  assert(actions.length>prior,'Phone settings refresh is immediate, not merely invalidation');
  assert(!JS.includes("localStorage.removeItem(CATALOG_FETCH_AT_KEY);\n    Pebble.sendAppMessage({COMMAND:'CTRL_INVALIDATE'}"),
    'Force refresh no longer postpones discovery');
  console.log('Watch Settings, persisted volume, theme/text synchronization, fan prioritization and true force recheck passed');
})().catch(e=>{console.error(e);process.exit(1);});
