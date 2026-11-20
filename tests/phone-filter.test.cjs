'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const js=fs.readFileSync('src/pkjs/index.js','utf8');
const devices=[
  {id:'light.kitchen',name:'Kitchen ceiling',room:'Kitchen',domain:'light'},
  {id:'fan.bedroom',name:'Bedroom fan',room:'Bedroom',domain:'fan'},
  {id:'switch.guest_ceiling_fan',name:'Guest room',room:'Guest',domain:'switch'},
  {id:'input_boolean.attic_exhaust_fan',name:'Attic control',room:'Attic',domain:'input_boolean'},
  {id:'switch.desk',name:'Desk outlet',room:'Office',domain:'switch'},
  {id:'scene.movie',name:'Movie mode',room:'Cinema',domain:'scene'},
  {id:'switch.fanatic',name:'Fanatic device',room:'Other',domain:'switch'}
];
const storage={},handlers={},clays=[];
const Pebble={
  addEventListener:(name,fn)=>handlers[name]=fn,
  getActiveWatchInfo:()=>({platform:'emery'}),
  openURL:()=>{},
  sendAppMessage:(m,ok)=>{if(ok)ok();},
  invokeAction:({action,args})=>{
    assert.strictEqual(action,'list_controls');
    assert.strictEqual(args.metadata_only,true);
    const offset=Number(args.offset)||0;
    return Promise.resolve({ok:true,text:JSON.stringify(devices.slice(offset,offset+48))});
  }
};
const localStorage={
  getItem:k=>Object.prototype.hasOwnProperty.call(storage,k)?storage[k]:null,
  setItem:(k,v)=>{storage[k]=String(v);},
  removeItem:k=>{delete storage[k];}
};
function Clay(config,customFn){
  this.config=config;this.customFn=customFn;this.meta={userData:{}};
  this.generateUrl=()=> 'pebble://settings';
  clays.push(this);
}
const audio={diagnostics:()=>null,handleMessage:()=>false,stop:()=>{},speak:()=>Promise.resolve()};
vm.runInNewContext(js,{
  Pebble,localStorage,console,Date,JSON,Math,Number,String,Promise,
  setTimeout:()=>1,setInterval:()=>1,
  require:name=>name==='pebble-clay'?Clay:name==='./ha_audio'?{create:()=>audio}:
    (()=>{throw Error('Unexpected module '+name);})()
},{filename:'index.js'});
const flush=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
function node(){
  const flags=new Set();
  return {classList:{
    toggle:(c,force)=>{if(force)flags.add(c);else flags.delete(c);},
    contains:c=>flags.has(c)
  }};
}
(async()=>{
  handlers.appmessage({payload:{COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:0,CTRL_REV:0}});
  await flush();
  handlers.showConfiguration();
  const clay=clays[clays.length-1];
  assert(clay&&typeof clay.customFn==='function');
  const section=clay.config.filter(x=>x.type==='section')[2];
  const deviceConfigs=section.items.filter(x=>x.type==='checkboxgroup');
  assert.strictEqual(deviceConfigs.length,devices.length);
  const rooms=section.items.filter(x=>x.type==='heading'&&x.defaultValue!=='Watch devices');
  const records=Object.fromEntries(deviceConfigs.map(x=>[x.label,node()]));
  const headings=Object.fromEntries(rooms.map(x=>[x.defaultValue,node()]));
  const deviceItems={};
  deviceConfigs.forEach(x=>deviceItems[x.messageKey]={$element:[records[x.label]]});
  const callbacks={};
  const changes=[];
  const switchInput={
    checked:false,
    get(){return this.checked;},
    on(name,fn){assert.strictEqual(name,'change');changes.push(fn);}
  };
  const page={
    EVENTS:{AFTER_BUILD:'AFTER_BUILD'},meta:clay.meta,
    on:(name,fn)=>{callbacks[name]=fn;},
    getItemByMessageKey:key=>key==='SHOW_ALL_DEVICES'?
      switchInput:deviceItems[key],
    getItemById:()=>{throw Error('Room headers must not be mutated');}
  };
  clay.customFn.call(page);
  assert.strictEqual(typeof callbacks.AFTER_BUILD,'function');
  callbacks.AFTER_BUILD();
  assert.strictEqual(changes.length,1,'Clay native change handler is registered');
  assert(js.includes('control.get()')&&js.includes("control.on('change',render)"),
    'Filter must use Clay item API, not fragile DOM querySelector');

  function hidden(label){return records[label].classList.contains('ha-device-filter-hidden');}
  function roomHidden(room){return headings[room].classList.contains('ha-room-filter-hidden');}
  assert(!hidden('Kitchen ceiling'));
  assert(!hidden('Bedroom fan'));
  assert(!hidden('Guest room'),'Fan whose entity ID ends in _fan remains visible');
  assert(!hidden('Attic control'),'Fan-like input_boolean is visible');
  assert(!hidden('Desk outlet'),'Ordinary switches included by default');
  assert(hidden('Movie mode'),'Scene hidden by default');
  assert(!hidden('Fanatic device'),'All ordinary switches included by default');
  for(const room of ['Kitchen','Bedroom','Guest','Attic'])
    assert(!roomHidden(room),'Visible room header remains: '+room);
  for(const room of ['Office','Cinema','Other'])
    assert(!roomHidden(room),'Room header remains present even with only hidden types: '+room);

  switchInput.checked=true;changes[0]();
  for(const config of deviceConfigs)
    assert(!hidden(config.label),'Show All displays '+config.label);
  for(const room of Object.keys(headings))
    assert(!roomHidden(room),'Show All displays room '+room);

  switchInput.checked=false;changes[0]();
  assert(!hidden('Bedroom fan')&&!hidden('Guest room'),
    'Turning Show All off again cannot hide any fan');
  assert(!hidden('Desk outlet')&&hidden('Movie mode'));
  assert(!roomHidden('Bedroom')&&!roomHidden('Guest'));
  assert(!roomHidden('Office')&&!roomHidden('Cinema'));
  assert.strictEqual(rooms.length,7,'Every room header remains in the filtered view');

  assert(js.includes('.component-checkbox.ha-device-filter-hidden{display:none!important;}'),
    'Hidden class must override layout display:flex!important');
  assert(!js.includes('ha-room-filter-hidden'),
    'Room headings must not be hidden by display-only filtering');
  assert(!storage.HA_HIDDEN_V1&&!storage.HA_FAVORITES_V1,
    'Visual filter must not modify hide/favorite selections');
  console.log('Phone settings filter: Off/On/Off, lights/fans/switches, persistent room headers and no preference mutation passed');
})().catch(e=>{console.error(e);process.exit(1);});
