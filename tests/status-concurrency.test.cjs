'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('src/pkjs/index.js','utf8');
const items=Array.from({length:40},(_,i)=>({id:'light.test_'+String(i).padStart(2,'0'),name:'Light '+i,room:'Office',domain:'light'}));
const handlers={},pending=[],messages=[],acks=[],store={};
let active=0,maxActive=0,requested=0;
const Pebble={
 addEventListener:(event,fn)=>handlers[event]=fn,
 getActiveWatchInfo:()=>({platform:'emery'}),
 openURL:()=>{},
 sendAppMessage:(msg,ok)=>{
   messages.push(msg);
   if(msg.COMMAND==='CTRL_STATE')acks.push(ok);
   else if(ok)ok();
 },
 invokeAction:({action,args})=>{
   if(action==='list_controls')return Promise.resolve({ok:true,text:JSON.stringify(items.slice(args.offset||0,(args.offset||0)+48))});
   if(action==='get_state'){
     requested++;active++;maxActive=Math.max(maxActive,active);
     return new Promise(resolve=>pending.push({id:args.entity_id,done:()=>{active--;resolve({ok:true,text:'{"state":"on"}'});}}));
   }
   throw Error('Unexpected '+action);
 }
};
const storage={getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=String(v),removeItem:k=>delete store[k]};
function Clay(){this.meta={userData:{}};this.generateUrl=()=>'';}
const audio={diagnostics:()=>null,handleMessage:()=>false,stop:()=>{},speak:()=>Promise.resolve()};
vm.runInNewContext(source,{Pebble,localStorage:storage,Date,JSON,Math,Promise,Number,String,console,
 setInterval:()=>0,setTimeout:()=>0,require:x=>x==='pebble-clay'?Clay:x==='./ha_audio'?{create:()=>audio}:(()=>{throw Error(x);})()},{filename:'index.js'});
const tick=async()=>{for(let i=0;i<18;i++)await new Promise(r=>setImmediate(r));};
(async()=>{
 handlers.appmessage({payload:{COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:0,CTRL_REV:0}});
 await tick();
 assert.strictEqual(messages.filter(x=>x.COMMAND==='CTRL_ROW').length,32);
 assert.strictEqual(maxActive,6,'Six initial status requests run concurrently');
 assert.strictEqual(requested,6);
 assert.strictEqual(messages.filter(x=>x.COMMAND==='CTRL_STATE').length,0,'Metadata appears before live statuses');
 pending.shift().done();pending.shift().done();pending.shift().done();
 await tick();
 assert.strictEqual(acks.length,1,'Only one Bluetooth status is unacknowledged');
 assert.strictEqual(active,6,'Workers refill as responses arrive');
 acks.shift()();await tick();
 assert.strictEqual(acks.length,1,'ACK releases next queued update');
 const oldRev=messages.find(x=>x.COMMAND==='CTRL_DONE').CTRL_REV;
 handlers.appmessage({payload:{COMMAND:'CTRL_REQUEST',CTRL_INDEX:0,CTRL_OFFSET:32,CTRL_REV:0}});
 await tick();
 assert(messages.some(x=>x.COMMAND==='CTRL_DONE'&&x.CTRL_OFFSET===32));
 const cutoff=messages.length;
 const old=pending.find(x=>x.id==='light.test_03');
 if(old)old.done();
 await tick();
 assert(messages.slice(cutoff).filter(x=>x.COMMAND==='CTRL_STATE').every(x=>x.CTRL_REV!==oldRev));
 assert(source.includes('var STATE_FETCH_CONCURRENCY=6'));
 console.log('Six parallel state requests, BLE ACK serialization, and stale-page isolation passed');
})().catch(e=>{console.error(e);process.exit(1);});
