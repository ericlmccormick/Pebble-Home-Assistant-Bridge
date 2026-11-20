'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const c=fs.readFileSync('src/c/ha_controls.c','utf8');
const js=fs.readFileSync('src/pkjs/index.js','utf8');
const pkg=require('../package.json');
assert(pkg.pebble.messageKeys.includes('CTRL_LEVEL'));
assert(pkg.pebble.messageKeys.includes('CTRL_ADJUSTABLE'));
assert(pkg.pebble.messageKeys.includes('CTRL_DIRECTION'));
assert(pkg.pebble.messageKeys.includes('CTRL_ADVANCED'));
assert(c.includes('return m==s_home_menu?row_height():(s_large_text?58:38)'),
  'Compact device rows preserve readable home navigation');
assert(c.includes('(unknown||dimmed)?(highlighted?ui_selected_bg():ui_bg())'),
  'Unknown/off/unavailable badges remain unfilled until live status arrives');
assert(c.includes('GColor category=kind_color(kind)'),
  'Device type artwork keeps a distinctive category color before state loads');
assert(c.includes('detail_push(index,false)'));
assert(c.includes('send_command("CTRL_INSPECT",index)'));
assert(c.includes('window_single_click_subscribe(BUTTON_ID_UP,detail_up_click)'));
assert(c.includes('window_single_click_subscribe(BUTTON_ID_DOWN,detail_down_click)'));
assert(c.includes('static void detail_click_config(void *context)'));
assert(c.includes('if(strcmp(command,"CTRL_DETAIL_OPEN")==0)'),
  'A live capability check opens details only for adjustable entities');
assert(js.includes("if(meta.adjustable){")&&js.includes('controlAct(index);'),
  'Simple entities toggle after live inspection; adjustable devices open details');
const state={
  'light.bed':{entity_id:'light.bed',state:'on',
    attributes:{brightness:128,supported_color_modes:['brightness']}},
  'fan.office':{entity_id:'fan.office',state:'on',
    attributes:{percentage:40,percentage_step:20,supported_features:1}},
  'switch.desk':{entity_id:'switch.desk',state:'off',attributes:{}}
};
const raw=[
  {id:'light.bed',domain:'light',room:'Bedroom',name:'Bed light',state:'on'},
  {id:'fan.office',domain:'fan',room:'Office',name:'Office fan',state:'on'},
  {id:'switch.desk',domain:'switch',room:'Office',name:'Desk',state:'off'}
];
const store={HA_ROOM_CACHE_FORMAT:'json_rooms_v2',HA_CONTROLS_CACHE_V1:JSON.stringify(raw),
  HA_WATCH_PAGE_IDS_V3:JSON.stringify(raw.map(r=>r.id))};
const sent=[],calls=[],handlers={};
const Pebble={
  addEventListener:(event,fn)=>handlers[event]=fn,
  getActiveWatchInfo:()=>({platform:'emery'}),
  sendAppMessage:(packet,ok)=>{sent.push(packet);if(ok)ok();},
  invokeAction:({action,args})=>{
    calls.push({action,args});
    let result={};
    if(action==='get_state')result=state[args.entity_id];
    else if(action==='call_service'){
      const s=state[args.data.entity_id];
      if(args.domain==='light')s.attributes.brightness=
        Math.round((args.data.brightness_pct||0)*255/100);
      if(args.domain==='fan')s.attributes.percentage=args.data.percentage||0;
      s.state=args.service==='turn_off'?'off':'on';
    }else if(action==='control_entity'){
      const s=state[args.entity_id];s.state=s.state==='on'?'off':'on';
    }else throw Error('Unexpected plugin action: '+action);
    return Promise.resolve({ok:true,text:JSON.stringify(result)});
  }
};
const storage={getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=String(v),
  removeItem:k=>delete store[k]};
function Clay(){}
Clay.prototype.generateUrl=()=> 'pebble://settings';
const audio={diagnostics:()=>null,handleMessage:()=>false,stop:()=>{}};
vm.runInNewContext(js,{Pebble,localStorage:storage,console,JSON,Date,Math,
  Number,String,Promise,setTimeout:cb=>{cb();return 1;},
  require:n=>n==='pebble-clay'?Clay:{create:()=>audio}},{filename:'index.js'});
function fire(command,index,dir){
  handlers.appmessage({payload:{COMMAND:command,CTRL_INDEX:index,CTRL_DIRECTION:dir}});
}
async function flush(){for(let i=0;i<12;i++)await new Promise(ok=>setImmediate(ok));}
(async()=>{
  fire('CTRL_INSPECT',0);await flush();
  assert(sent.some(x=>x.COMMAND==='CTRL_DETAIL_OPEN'&&x.CTRL_INDEX===0),
    'Dimmable light opens only after a live capability lookup');
  fire('CTRL_DETAILS',0);await flush();
  assert(sent.some(x=>x.COMMAND==='CTRL_DETAIL_STATE'&&x.CTRL_ADJUSTABLE===1&&
    x.CTRL_LEVEL===50),'Dimmable light reports 50%');
  fire('CTRL_ADJUST',0,1);await flush();
  assert(calls.some(x=>x.action==='call_service'&&x.args.domain==='light'&&
    x.args.service==='turn_on'&&x.args.data.brightness_pct===60),
    'UP raises dimmer by 10%');
  fire('CTRL_DETAILS',1);await flush();
  assert(sent.some(x=>x.COMMAND==='CTRL_DETAIL_STATE'&&x.CTRL_LEVEL===40));
  fire('CTRL_ADJUST',1,-1);await flush();
  assert(calls.some(x=>x.action==='call_service'&&x.args.domain==='fan'&&
    x.args.service==='set_percentage'&&x.args.data.percentage===20),
    'DOWN respects supported fan step');
  fire('CTRL_DETAILS',2);await flush();
  assert(sent.some(x=>x.COMMAND==='CTRL_DETAIL_STATE'&&x.CTRL_ADJUSTABLE===0),
    'Non-dimmable switch has no level');
  fire('CTRL_ACT',2);await flush();
  assert(calls.some(x=>x.action==='control_entity'&&x.args.entity_id==='switch.desk'),
    'Switch still toggles');
  console.log('Compact rows, on/off badges, detail read, dimmers, fans and switch passed');
})().catch(e=>{console.error(e);process.exit(1);});
