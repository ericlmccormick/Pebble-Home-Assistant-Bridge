'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const js=fs.readFileSync('src/pkjs/index.js','utf8');
const rows=[
 {id:'light.kitchen',name:'Ceiling light',room:'Kitchen',domain:'light'},
 {id:'light.kitchen',name:'Ceiling light',room:'Kitchen',domain:'light'},
 {id:'light.kitchen_duplicate',name:'Ceiling light',room:'Kitchen',domain:'light'},
 {id:'switch.kitchen_ceiling_light',name:'Ceiling fixture',room:'Kitchen',domain:'switch'},
 {id:'fan.bedroom',name:'Bedroom fan',room:'Bedroom',domain:'fan'},
 {id:'switch.attic_fan',name:'Attic',room:'Attic',domain:'switch'},
 {id:'switch.desk',name:'Desk',room:'Office',domain:'switch'},
 {id:'switch.garage_outlet',name:'Garage',room:'Garage',domain:'switch'},
 {id:'scene.movie',name:'Movie',room:'Cinema',domain:'scene'},
 {id:'light.annie_cave_light',name:'Annie Cave',room:'Annie Cave',domain:'light'},
 {id:'fan.annie_cave_fan',name:'Annie Cave',room:'Annie Cave',domain:'fan'},
 {id:'light.annie_cave_lamp',name:'Annie Cave Lamp',room:'Annie Cave',domain:'light'},
 {id:'switch.annie_cave_lamp_relay',name:'Annie Cave Lamp',room:'Annie Cave',domain:'switch'},
 {id:'fan.guest_fan',name:'Guest Fan',room:'Guest Room',domain:'fan'},
 {id:'light.back_yard_flood',name:'Back yard flood lights',room:'Back Yard',domain:'light'}
];
const store={},handlers={},clays=[],sent=[];
const localStorage={
 getItem:k=>Object.prototype.hasOwnProperty.call(store,k)?store[k]:null,
 setItem:(k,v)=>{store[k]=String(v);},
 removeItem:k=>delete store[k]
};
function Clay(cfg,customFn){this.cfg=cfg;this.customFn=customFn;this.generateUrl=()=> 'pebble://settings';clays.push(this);}
const Pebble={
 addEventListener:(name,fn)=>handlers[name]=fn,
 getActiveWatchInfo:()=>({platform:'emery'}),
 openURL:()=>{},
 sendAppMessage:(m,ok)=>{sent.push(m);if(ok)ok();},
 invokeAction:({action,args})=>{
   if(action!=='list_controls')throw Error('Unexpected action '+action);
   return Promise.resolve({ok:true,text:JSON.stringify(rows.slice(args.offset||0,(args.offset||0)+48))});
 }
};
const audio={diagnostics:()=>null,handleMessage:()=>false,stop:()=>{},speak:()=>Promise.resolve()};
vm.runInNewContext(js,{Pebble,localStorage,console,Date,JSON,Math,Number,String,Promise,
 setTimeout:()=>1,setInterval:()=>1,
 require:n=>n==='pebble-clay'?Clay:n==='./ha_audio'?{create:()=>audio}:
   (()=>{throw Error('module '+n)})()},{filename:'index.js'});
async function flush(){for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));}
(async()=>{
 handlers.showConfiguration();
 await flush();
 const config=clays[clays.length-1].cfg;
 const sec=config.filter(x=>x.type==='section')[2];
 assert(!sec.items.some(x=>x.messageKey==='SHOW_ALL_DEVICES'),
   'Device type toggle is completely removed');
 const devices=sec.items.filter(x=>x.type==='checkboxgroup');
 assert.strictEqual(devices.length,12,
   'Exact IDs, mirrored same-type names, and relay-backed lights are consolidated');
 const labels=devices.map(x=>x.label);
 for(const name of ['Ceiling light','Ceiling fixture','Fan','Switch','Desk','Movie','Light','Lamp','Guest Fan','flood lights'])
   assert(labels.includes(name),'Every distinct device type remains accessible: '+name);
 assert(sec.items.filter(x=>x.type==='heading').some(x=>x.defaultValue==='Bedroom'));
 assert(sec.items.filter(x=>x.type==='heading').some(x=>x.defaultValue==='Cinema'));
 assert(sec.items.filter(x=>x.type==='heading').some(x=>x.defaultValue==='Annie Cave'));
 // Same HA friendly_name in the same room must be two separate controls,
 // labeled by entity domain. Their unique IDs stay associated with toggles.
 const cave=devices.filter(x=>x.label==='Fan'||x.label==='Light');
 assert(cave.some(x=>x.label==='Fan')&&cave.some(x=>x.label==='Light'));
 assert.strictEqual(devices.filter(x=>x.label==='Light').length,1);
 assert.strictEqual(devices.filter(x=>x.label==='Ceiling light').length,1,
   'Identical labels and types in the same room display once');
 assert.strictEqual(devices.filter(x=>x.label==='Lamp').length,1,
   'Light and switch mirror of Annie Cave Lamp displays once');
 assert.strictEqual(devices.filter(x=>x.label==='Fan').length,2,
   'Independent fans in Annie Cave and Attic remain separate');
 // The device metadata sent to the watch uses the same compact labels.
 handlers.appmessage({payload:{COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:0,CTRL_REV:0}});
 await flush();
 const names=sent.filter(x=>x.COMMAND==='CTRL_ROW').map(x=>x.CTRL_NAME);
 assert(names.includes('Fan')&&names.includes('Light')&&names.includes('Lamp'),
   'Watch pages contain contextual device labels, not duplicated room names');

 assert(js.includes('controlKind(r.domain,r.name,r.id)'));
 assert(js.includes('function isLightControl('));
 assert(js.includes("if(isFanControl(row))return 3"));
 assert(js.includes("if(isLightControl(row))return 1"));
 const kitchenIndex=devices.findIndex(x=>x.label==='Ceiling light');
 assert(kitchenIndex>=0);
 const values={};
 values['DEV_'+kitchenIndex]={value:[true,true]};
 handlers.webviewclosed({response:encodeURIComponent(JSON.stringify(values))});
 const savedFav=JSON.parse(store.HA_FAVORITES_V1);
 const savedHidden=JSON.parse(store.HA_HIDDEN_V1);
 assert(savedFav.includes('light.kitchen')&&savedFav.includes('light.kitchen_duplicate'),
   'Favorite setting propagates to both mirrored entity IDs');
 assert(savedHidden.includes('light.kitchen')&&savedHidden.includes('light.kitchen_duplicate'),
   'Hide setting prevents a mirrored entity reappearing on the watch');
 assert(!js.includes("SHOW_ALL_DEVICES"));
 console.log('Full settings without toggle, deduplicated IDs/labels, all rooms and type icon classification passed');
})().catch(e=>{console.error(e);process.exit(1);});
