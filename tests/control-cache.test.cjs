'use strict';
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const JS=fs.readFileSync('src/pkjs/index.js','utf8');
const C=fs.readFileSync('src/c/ha_controls.c','utf8');
const manifest=require('../package.json');
const rows=[
  {id:'light.kitchen',name:'Kitchen Lamp',room:'Kitchen',domain:'light',state:'off'},
  {id:'scene.evening',name:'Evening Lights',room:'Living Room',domain:'scene',state:'off'},
  {id:'script.relax',name:'Relax',room:'Living Room',domain:'script',state:'off'}
];
function harness(storage){
  let handlers={},outgoing=[],invoked=[],opened=[],sourceTimeout=[],configs=[];
  const localStorage={
    getItem:key=>Object.prototype.hasOwnProperty.call(storage,key)?storage[key]:null,
    setItem:(key,value)=>{storage[key]=String(value);},
    removeItem:key=>{delete storage[key];}
  };
  const Pebble={
    addEventListener:(name,handler)=>{handlers[name]=handler;},
    getActiveWatchInfo:()=>({platform:'emery'}),
    openURL:url=>opened.push(url),
    sendAppMessage:(message,ok,err)=>{outgoing.push(message);if(ok)ok();},
    invokeAction:({action,args})=>{
      invoked.push({action,args});
      if(action==='list_controls')return Promise.resolve({ok:true,text:JSON.stringify(rows)});
      if(action==='control_entity')return Promise.resolve({ok:true,text:'{}'});
      if(action==='get_state')return Promise.resolve({ok:true,text:JSON.stringify({state:'on'})});
      throw Error('Unexpected plugin action '+action);
    }
  };
  function Clay(config){configs.push(config);this.generateUrl=()=> 'pebble://settings';}
  const audio={
    diagnostics:()=>null,handleMessage:()=>false,stop:()=>{},
    speak:()=>Promise.resolve()
  };
  const context={Pebble,localStorage,console,Date,JSON,Math,Promise,Number,String,
    setTimeout:(cb,ms)=>{sourceTimeout.push({cb,ms});return 1;},
    setInterval:()=>1,
    require:name=>name==='pebble-clay'?Clay:name==='./ha_audio'?{create:()=>audio}:
      (()=>{throw Error('Unexpected require '+name);})()
  };
  vm.runInNewContext(JS,context,{filename:'index.js'});
  return {handlers,outgoing,invoked,opened,configs,storage,fire:m=>handlers.appmessage({payload:m})};
}
async function flush(){for(let i=0;i<9;i++)await new Promise(resolve=>setImmediate(resolve));}
(async()=>{
  const storage={};
  let h=harness(storage);
  h.fire({COMMAND:'CTRL_REQUEST',CTRL_REV:0});
  await flush();
  assert.strictEqual(h.invoked.filter(x=>x.action==='list_controls').length,1);
  let rowsOut=h.outgoing.filter(x=>x.COMMAND==='CTRL_ROW');
  assert.strictEqual(rowsOut.length,3,'First request sends complete catalog');
  assert.strictEqual(rowsOut.find(x=>x.CTRL_NAME==='Evening Lights').CTRL_STATUS,'Run');
  assert.strictEqual(rowsOut.find(x=>x.CTRL_NAME==='Relax').CTRL_STATUS,'Run');
  assert(rowsOut.every(x=>!x.CTRL_ID),'Device IDs stay on phone, not over Bluetooth');
  const done=h.outgoing.find(x=>x.COMMAND==='CTRL_DONE');
  assert(done&&Number.isInteger(done.CTRL_REV));
  assert.strictEqual(done.CTRL_TOTAL,3);
  assert(storage.HA_WATCH_IDS_V2,'Last acknowledged watch index-to-ID mapping persists');

  h.outgoing.length=0;
  h.fire({COMMAND:'CTRL_REQUEST',CTRL_REV:done.CTRL_REV});
  await flush();
  assert.strictEqual(h.outgoing.filter(x=>x.COMMAND==='CTRL_ROW').length,0,
    'Unchanged catalog must not retransmit rows');
  assert.strictEqual(h.invoked.filter(x=>x.action==='list_controls').length,1,
    'Warm catalog must not call Bridge again');
  assert.strictEqual(h.outgoing.filter(x=>x.COMMAND==='CTRL_DONE').length,1);

  // A PebbleKit JS process restart must not break actions from the watch cache.
  h=harness(storage);
  h.fire({COMMAND:'CTRL_ACT',CTRL_INDEX:1});
  await flush();
  assert.strictEqual(h.invoked[0].action,'control_entity');
  assert.strictEqual(h.invoked[0].args.entity_id,'scene.evening');
  assert(!h.invoked.some(x=>x.action==='get_state'),'Scene is never read as on/off');
  assert(h.outgoing.some(x=>x.COMMAND==='CTRL_ACTION_DONE'&&x.CTRL_STATUS==='Triggered'));

  h=harness(storage);
  h.fire({COMMAND:'CTRL_ACT',CTRL_INDEX:0});
  await flush();
  assert(h.invoked.some(x=>x.action==='get_state'),'Light is read after toggling');
  assert(h.outgoing.some(x=>x.COMMAND==='CTRL_STATE'&&x.CTRL_STATUS==='on'));

  h.handlers.showConfiguration();
  assert.strictEqual(h.opened.length,1,'Cached settings open without waiting for Bridge');
  const config=h.configs[h.configs.length-1];
  const sections=config.filter(x=>x.type==='section');
  const headings=sections.map(x=>x.items[0].defaultValue);
  assert.strictEqual(headings.join('|'),'Display|Home Assistant Bridge|Watch devices',
    'Display and Bridge settings precede the device list');
  assert(!JSON.stringify(config).includes('Latest Bridge and watch audio diagnostics'),
    'Diagnostics panel is removed');
  assert(!JSON.stringify(config).includes('pcm_debug_display'),
    'No hidden diagnostics remnants on the page');
  const devices=sections[2].items.filter(x=>x.type==='checkboxgroup');
  assert.strictEqual(devices.length,3,'One grouped control per device');
  assert.strictEqual(devices[0].label,'Kitchen Lamp');
  assert(JS.includes('.component-checkbox{display:flex!important;align-items:center;gap:6px'),
    'Device names and actions must share one horizontal row');
  assert(JS.includes('font-size:14px!important')&&JS.includes('max-height:2.6em'),
    'Device names use smaller two-line text when needed');
  assert(JS.includes('.checkbox-group{display:flex;align-items:center;justify-content:flex-end'),
    'Both action icons must be right-aligned');
  assert(JS.includes('flex:0 0 44px')&&JS.includes('height:44px'),
    'Each icon keeps a 44-pixel touch target');
  assert(JS.includes('label:first-child i:before{content:"☆"')&&
      JS.includes('label:first-child input:checked+i:before{content:"★"'),
    'Star outlines/fills reflect native Favorite checkbox state');
  assert(JS.includes('label:nth-child(2) i:before{content:""')&&
      JS.includes('label:nth-child(2) i:after{content:""')&&
      JS.includes('rotate(-45deg)')&&
      JS.includes('label:nth-child(2) input:checked+i{color:#ff7a16'),
    'Hide control must draw a slash-circle with inactive and active colors');
  assert(JS.includes('label .label{position:absolute!important'),
    'Native control labels remain accessible but do not consume visual space');
  assert.strictEqual(devices[0].messageKey,'DEV_0');
  assert.strictEqual(JSON.stringify(devices[0].options),JSON.stringify(['Favorite','Hide']));
  assert.strictEqual(JSON.stringify(devices[0].defaultValue),JSON.stringify([false,false]),
    'Existing saved selections become checkboxes');
  assert(!sections[2].items.some(x=>x.messageKey&&/^(FAV_|HIDE_)/.test(x.messageKey)),
    'No duplicate per-device toggle rows');
  for(let i=0;i<48;i++)assert(manifest.pebble.messageKeys.includes('DEV_'+i+'[2]'),
    'Every dynamic checkbox group must have a Pebble message-key array');

  h.handlers.webviewclosed({response:encodeURIComponent(JSON.stringify({
    DEV_0:{value:[true,true]}
  }))});
  assert(JSON.parse(storage.HA_FAVORITES_V1).includes('light.kitchen'));
  assert(JSON.parse(storage.HA_HIDDEN_V1).includes('light.kitchen'));
  assert(h.outgoing.some(x=>x.COMMAND==='CTRL_INVALIDATE'),
    'Changing favorites or hide emits only one invalidation');

  h.outgoing.length=0;
  h.fire({COMMAND:'CTRL_REQUEST',CTRL_REV:done.CTRL_REV});
  await flush();
  assert.strictEqual(h.outgoing.filter(x=>x.COMMAND==='CTRL_ROW').length,2,
    'Hidden entity absent from the next watch catalog');
  const currentDone=h.outgoing.find(x=>x.COMMAND==='CTRL_DONE');
  assert.strictEqual(currentDone.CTRL_TOTAL,2);
  assert.notStrictEqual(currentDone.CTRL_REV,done.CTRL_REV);
  assert(storage.HA_FAVORITES_V1,'Favorites preserved even when a device is hidden');

  assert(C.includes('CACHE_REFRESH_SECONDS 3600'));
  assert(C.includes('static void catalog_restore(void)'));
  assert(C.includes('static void visible_rebuild(void)'));
  assert(C.includes('static void rooms_rebuild(void)'));
  assert(C.includes('static void catalog_request_if_due(void)'));
  assert(C.includes('PERSIST_DATA_MAX_LENGTH'));
  assert(C.includes('return s_large_text?80:46;'));
  assert(C.includes('home_title_top()'));
  for(const key of ['CTRL_REV','CTRL_TOTAL'])
    assert(manifest.pebble.messageKeys.includes(key));
  console.log('Catalog caching, no-repeat Bluetooth transport, JS restart, actions and hide/favorites passed');
})().catch(e=>{console.error(e);process.exit(1);});
