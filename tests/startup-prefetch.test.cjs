'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const JS=fs.readFileSync('src/pkjs/index.js','utf8');
const C=fs.readFileSync('src/c/ha_controls.c','utf8');
const entities=Array.from({length:40},(_,i)=>({
 id:'light.light_'+String(i).padStart(2,'0'),name:'Light '+String(i).padStart(2,'0'),room:'Home',domain:'light'
}));
const handlers={},calls=[],sent=[],pending=[],stateCounts={};
const data={'HA_FAVORITES_V1':JSON.stringify(['light.light_35'])};
let active=0,peak=0;
const storage={getItem:k=>Object.prototype.hasOwnProperty.call(data,k)?data[k]:null,setItem:(k,v)=>{data[k]=String(v);},removeItem:k=>delete data[k]};
const Pebble={addEventListener:(k,fn)=>handlers[k]=fn,getActiveWatchInfo:()=>({platform:'emery'}),openURL:()=>{},
 sendAppMessage:(msg,ok)=>{sent.push(msg);if(ok)ok();},
 invokeAction:({action,args})=>{
   calls.push({action,args});
   if(action==='list_controls')return Promise.resolve({ok:true,text:JSON.stringify(entities.slice(args.offset||0,(args.offset||0)+48))});
   if(action==='get_state'){
     active++;peak=Math.max(peak,active);
     stateCounts[args.entity_id]=(stateCounts[args.entity_id]||0)+1;
     return new Promise(resolve=>pending.push({id:args.entity_id,finish:()=>{active--;resolve({ok:true,text:JSON.stringify({state:'on'})});}}));
   }
   throw Error('Unexpected plugin action '+action);
 }
};
function Clay(){this.meta={userData:{}};this.generateUrl=()=>'';}
const audio={diagnostics:()=>null,handleMessage:()=>false,stop:()=>{},speak:()=>Promise.resolve()};
vm.runInNewContext(JS,{Pebble,localStorage:storage,Date,JSON,Math,Number,String,Promise,
 console,setInterval:()=>0,setTimeout:()=>0,require:n=>n==='pebble-clay'?Clay:n==='./ha_audio'?{create:()=>audio}:(()=>{throw Error(n);})()
},{filename:'index.js'});
const flush=async()=>{for(let i=0;i<25;i++)await new Promise(r=>setImmediate(r));};
(async()=>{
 assert(C.includes('send_command("CTRL_PREFETCH",-1);'),
   'Watch starts prefetch from home without opening device list');
 handlers.appmessage({payload:{COMMAND:'CTRL_PREFETCH'}});
 await flush();
 assert.strictEqual(peak,6,'Startup uses the same six-slot fetch budget');
 assert.strictEqual(sent.length,0,'Startup prefetch must not send a catalog or states to watch');
 assert(calls.some(x=>x.action==='list_controls'),'Startup discovers device metadata');
 assert(stateCounts['light.light_35'],'Favorites prioritized even beyond initial page');
 assert(!stateCounts['light.light_39'],'Do not prefetch other far-away pages');

 // Enter the first 32-device page while prefetch is still in flight. It
 // must share pending phone requests rather than duplicate get_state calls.
 handlers.appmessage({payload:{COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:0,CTRL_REV:0}});
 await flush();
 assert.strictEqual(sent.filter(x=>x.COMMAND==='CTRL_ROW').length,32);
 assert(sent.some(x=>x.COMMAND==='CTRL_DONE'));
 assert.strictEqual(peak,6);
 assert.strictEqual(stateCounts['light.light_00'],1,'Open section reuses startup request');
 let cutoff=sent.filter(x=>x.COMMAND==='CTRL_STATE').length;
 assert.strictEqual(cutoff,0,'State not on watch until Bridge request finishes');
 // Finish all outstanding prefetch and view work in small batches.
 for(let i=0;i<150;i++){
   while(pending.length)pending.shift().finish();
   await flush();
   if(active===0)break;
 }
 assert.strictEqual(active,0,'All phone requests finish');
 assert(sent.some(x=>x.COMMAND==='CTRL_STATE'&&x.CTRL_INDEX===0),
   'Prefetched response is transmitted after entering the device section');
 assert.strictEqual(stateCounts['light.light_00'],1,'Shared prefetch is not requested twice');
 assert(!('HA_STATE_PRELOAD' in data),'Statuses remain in memory, not persistent settings');
 console.log('Startup-only prefetch, six-slot budget, favorite priority, no early Bluetooth, and shared page state passed');
})().catch(e=>{console.error(e);process.exit(1);});
