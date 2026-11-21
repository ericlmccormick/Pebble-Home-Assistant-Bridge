'use strict';
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const JS=fs.readFileSync('src/pkjs/index.js','utf8');
const C=fs.readFileSync('src/c/ha_controls.c','utf8');
const manifest=require('../package.json');
const deviceRows=[];
for(let i=0;i<94;i++)deviceRows.push({
  id:'switch.item_'+String(i).padStart(3,'0'),name:'Switch '+String(i).padStart(3,'0'),
  room:i<50?'Kitchen':'Living Room',domain:'switch'
});
deviceRows.push({id:'fan.attic',name:'Attic Fan',room:'Attic',domain:'fan'});
deviceRows.push({id:'scene.evening',name:'Evening',room:'Living Room',domain:'scene'});
deviceRows.push({id:'light.porch',name:'Porch Light',room:'Porch',domain:'light'});
const storage={
  HA_HIDDEN_V1:JSON.stringify(['switch.item_090']),
  HA_FAVORITES_V1:JSON.stringify(['light.porch'])
};
function harness(store){
  const handlers={},sent=[],calls=[],configs=[],opened=[];
  const localStorage={
    getItem:k=>Object.prototype.hasOwnProperty.call(store,k)?store[k]:null,
    setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>delete store[k]
  };
  const Pebble={
    addEventListener:(k,fn)=>{handlers[k]=fn;},
    getActiveWatchInfo:()=>({platform:'emery'}),
    openURL:url=>opened.push(url),
    sendAppMessage:(m,ok)=>{sent.push(m);if(ok)ok();},
    invokeAction:({action,args})=>{
      calls.push({action,args});
      if(action==='list_controls'){
        assert.strictEqual(args.metadata_only,true,'Bridge discovery needs metadata only');
        const off=Number(args.offset)||0;
        return Promise.resolve({ok:true,text:JSON.stringify(deviceRows.slice(off,off+48))});
      }
      if(action==='get_state'){
        return Promise.resolve({ok:true,text:JSON.stringify({
          entity_id:args.entity_id,state:'on',
          attributes:args.entity_id.startsWith('fan.')?{percentage:40,supported_features:1}:{}
        })});
      }
      if(action==='control_entity')return Promise.resolve({ok:true,text:'{}'});
      throw Error('Unexpected action '+action);
    }
  };
  function Clay(cfg){configs.push(cfg);this.meta={userData:{}};this.generateUrl=()=> 'pebble://settings';}
  const audio={diagnostics:()=>null,handleMessage:()=>false,stop:()=>{},speak:()=>Promise.resolve()};
  const context={Pebble,localStorage,console,Date,JSON,Math,Promise,Number,String,
    setTimeout:()=>1,setInterval:()=>1,
    require:n=>n==='pebble-clay'?Clay:n==='./ha_audio'?{create:()=>audio}:
      (()=>{throw Error('Unexpected require '+n);})()
  };
  vm.runInNewContext(JS,context,{filename:'index.js'});
  return {handlers,sent,calls,configs,opened,storage:store,
    fire:msg=>handlers.appmessage({payload:msg})};
}
async function flush(){for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));}
(async()=>{
  const h=harness(storage);
  h.fire({COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:0,CTRL_REV:0});
  await flush();
  assert.strictEqual(h.calls.filter(x=>x.action==='list_controls').length,3,
    'Full 97-device catalog is fetched in three Bridge pages');
  assert.strictEqual(h.sent.filter(x=>x.COMMAND==='CTRL_ROW').length,32,
    'Watch sends one bounded page, not the entire catalog');
  const done=h.sent.find(x=>x.COMMAND==='CTRL_DONE');
  assert.strictEqual(done.CTRL_TOTAL,32);
  assert.strictEqual(done.CTRL_GRAND_TOTAL,96,'Only hidden devices are omitted');
  assert.strictEqual(done.CTRL_HAS_MORE,1);
  assert.strictEqual(done.CTRL_OFFSET,0);
  assert(h.sent.filter(x=>x.COMMAND==='CTRL_ROW').every(r=>
    !('CTRL_STATUS' in r)&&!('CTRL_ADVANCED' in r)),
    'Status and advanced capability are not pushed with names and rooms');
  assert(h.sent.some(m=>m.COMMAND==='CTRL_STATE'&&m.CTRL_REV===done.CTRL_REV),
    'Background status arrives after metadata with the matching revision');
  assert(h.calls.some(c=>c.action==='get_state'),
    'Only visible watch-page devices are read in the background');
  assert(JSON.parse(storage.HA_CONTROLS_CACHE_V1).every(x=>
    !('state' in x)&&!('advanced' in x)&&!('brightness' in x)),
    'Phone remembers only metadata');

  h.sent.length=0;
  h.fire({COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:32,CTRL_REV:0});
  await flush();
  assert.strictEqual(h.sent.filter(x=>x.COMMAND==='CTRL_ROW').length,32,
    'Second 32-device page is accessible');
  assert.strictEqual(h.sent.find(x=>x.COMMAND==='CTRL_DONE').CTRL_OFFSET,32);
  h.sent.length=0;
  h.fire({COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:64,CTRL_REV:0});
  await flush();
  assert.strictEqual(h.sent.filter(x=>x.COMMAND==='CTRL_ROW').length,32);
  assert.strictEqual(h.sent.find(x=>x.COMMAND==='CTRL_DONE').CTRL_HAS_MORE,0,
    'Final page has no Next navigation');
  assert.strictEqual(h.calls.filter(x=>x.action==='list_controls').length,3,
    'Page changes use phone cache and no extra Bridge requests');

  // Settings displays ALL entities, not only the 32 currently on watch or
  // the old 48 reserved Clay keys. Filter is a view preference, not deletion.
  h.handlers.showConfiguration();
  const cfg=h.configs[h.configs.length-1];
  const sections=cfg.filter(x=>x.type==='section');
  assert.strictEqual(sections.map(x=>x.items[0].defaultValue).join('|'),
    'Display|Home Assistant Bridge|Watch devices');
  const devices=sections[2].items.filter(x=>x.type==='checkboxgroup');
  assert.strictEqual(devices.length,97);
  assert.strictEqual(devices[96].messageKey,'DEV_96');
  assert(!sections[2].items.some(x=>x.messageKey==='SHOW_ALL_DEVICES'),
    'Removed unreliable device type filter from phone settings');
  assert(sections[2].items.filter(x=>x.type==='heading').length>=2,
    'Keep room headings above devices');
  h.handlers.webviewclosed({response:encodeURIComponent(JSON.stringify({
    DEV_96:{value:[true,false]}
  }))});
  assert(JSON.parse(storage.HA_FAVORITES_V1).includes('light.porch'));
  assert(!JSON.parse(storage.HA_HIDDEN_V1).includes('light.porch'));

  // Selecting the fan on any page fetches its current status/capabilities,
  // only after the device is selected.
  h.sent.length=0;
  h.fire({COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:0,CTRL_REV:0});
  await flush();
  const currentIds=JSON.parse(storage.HA_WATCH_PAGE_IDS_V3);
  const fanIndex=currentIds.indexOf('fan.attic');
  assert(fanIndex>=0);
  const callsBefore=h.calls.filter(x=>x.action==='get_state').length;
  h.fire({COMMAND:'CTRL_INSPECT',CTRL_INDEX:fanIndex});
  await flush();
  assert.strictEqual(h.calls.filter(x=>x.action==='get_state').length,callsBefore+1,
    'Selected fan gets one fresh lookup beyond background statuses');
  assert(h.sent.some(x=>x.COMMAND==='CTRL_DETAIL_OPEN'&&x.CTRL_INDEX===fanIndex));
  assert(h.sent.some(x=>x.COMMAND==='CTRL_DETAIL_STATE'&&x.CTRL_ADJUSTABLE===1));

  // Recheck requests fresh metadata, even when the catalog is already warm.
  const before=h.calls.filter(x=>x.action==='list_controls').length;
  h.sent.length=0;
  h.fire({COMMAND:'CTRL_FORCE_REFRESH'});
  await flush();
  assert(h.calls.filter(x=>x.action==='list_controls').length>before);
  assert(h.sent.some(x=>x.COMMAND==='CTRL_DONE'));

  assert(!JS.includes('.slice(0,48)'), 'No 48-device UI selection cutoff');
  assert(C.includes('#define PAGE_SIZE 32'),'Watch buffers a finite page only');
  assert(C.includes('static void cache_schema_migrate(void)'));
  assert(C.includes('sizeof(CachedRow)*PAGE_SIZE'));
  assert(C.includes('s_page_offset'));
  assert(C.includes('More devices'));
  assert(C.includes('s_incoming[index]'),'Atomic page staging prevents partial lists');
  assert(!C.includes('catalog_store_status('),'Status must never be persisted');
  assert(C.includes('!state[0]'),'Unknown state must draw a neutral icon until inspected');
  for(const key of ['CTRL_OFFSET','CTRL_HAS_MORE','CTRL_GRAND_TOTAL'])
    assert(manifest.pebble.messageKeys.includes(key),'Missing page protocol key '+key);
  console.log('Full catalog, unfiltered settings, page-by-page live states and adjustable device lookup passed');
})().catch(e=>{console.error(e);process.exit(1);});
