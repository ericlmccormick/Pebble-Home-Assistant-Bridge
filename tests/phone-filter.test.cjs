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
 {id:'scene.movie',name:'Movie',room:'Cinema',domain:'scene'}
];
const store={},handlers={},clays=[];
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
 sendAppMessage:(m,ok)=>{if(ok)ok();},
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
 assert.strictEqual(devices.length,6,
   'Repeat entity IDs and mirrored same-room/name/domain entries are not repeated');
 const labels=devices.map(x=>x.label);
 for(const name of ['Ceiling light','Ceiling fixture','Bedroom fan','Attic','Desk','Movie'])
   assert(labels.includes(name),'Every distinct device type remains accessible: '+name);
 assert(sec.items.filter(x=>x.type==='heading').some(x=>x.defaultValue==='Bedroom'));
 assert(sec.items.filter(x=>x.type==='heading').some(x=>x.defaultValue==='Cinema'));
 assert(js.includes('controlKind(r.domain,r.name,r.id)'));
 assert(js.includes('function isLightControl('));
 assert(js.includes("if(isFanControl(row))return 3"));
 assert(js.includes("if(isLightControl(row))return 1"));
 assert(!js.includes("SHOW_ALL_DEVICES"));
 console.log('Full settings without toggle, deduplicated IDs/labels, all rooms and type icon classification passed');
})().catch(e=>{console.error(e);process.exit(1);});
