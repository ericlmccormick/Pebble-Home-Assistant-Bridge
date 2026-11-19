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
  let handlers={},outgoing=[],invoked=[],opened=[],sourceTimeout=[];
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
  function Clay(){this.generateUrl=()=> 'pebble://settings';}
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
  return {handlers,outgoing,invoked,opened,storage,fire:m=>handlers.appmessage({payload:m})};
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
  h.handlers.webviewclosed({response:encodeURIComponent(JSON.stringify({
    FAV_0:{value:true},HIDE_0:{value:true}
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
