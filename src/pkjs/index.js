// Home Assistant AI — Bridge-only Pebble app.
// Home Assistant credentials, conversation API, and TTS are owned by the
// Home Assistant Bridge plugin. Audio is the shared ha_audio.js SDK.
'use strict';
var Clay=require('pebble-clay');
var HA_PLUGIN_UUID='a74370b6-929c-4ec0-b7ee-2fc6fca8db57';
var hapticValues={off:0,low:1,medium:2,high:3};
var hapticLevel=localStorage.getItem('HAPTIC_LEVEL')||'medium';
var autoSend=localStorage.getItem('AUTO_SEND')!=='false';
var enableTts=localStorage.getItem('ENABLE_TTS')!=='false';
var fontChoice=localStorage.getItem('FONT_CHOICE')||((parseInt(localStorage.getItem('FONT_SIZE')||'24',10)>24)?'large':'normal');
var themeMode=localStorage.getItem('HA_THEME_MODE')||'auto';
var WEATHER_PLUGIN_UUID='7f7b6c10-93e0-4f4c-9237-7e8204c5a121';
var weatherSource=null;
var weatherSunrise=0,weatherSunset=0;
var weatherUpdatedAt=0;
try {
  var weatherSaved=JSON.parse(localStorage.getItem('HA_WEATHER_SUN_V1')||'null');
  if(weatherSaved&&Number(weatherSaved.savedAt)>Date.now()-24*3600*1000){
    weatherSunrise=Number(weatherSaved.sunrise)||0;
    weatherSunset=Number(weatherSaved.sunset)||0;
    weatherUpdatedAt=Number(weatherSaved.savedAt)||0;
  }
}catch(e){}
var themeDarkSent=null,settingsReady=false;
function sunEpoch(v){
  if(v&&v.timestamp&&v.timestamp.value!=null)v=v.timestamp.value;
  var n=Number(v);
  if(!isFinite(n)||n<1000000000)return 0;
  return n>1e12?Math.floor(n/1000):Math.floor(n);
}
function effectiveThemeDark(){
  if(themeMode==='night')return true;
  if(themeMode==='day')return false;
  // In Auto, follow Weather+ local sunrise/sunset. Never force an
  // arbitrary 6 AM / 6 PM schedule when solar data is absent.
  var now=Math.floor(Date.now()/1000);
  if(weatherSunrise>0&&weatherSunset>weatherSunrise&&Date.now()-weatherUpdatedAt<24*3600*1000)
    return now<weatherSunrise||now>=weatherSunset;
  // Deterministic fallback without a Weather+ source: system appearance
  // is not observable in PebbleKit JS; retain last cached theme or day.
  return localStorage.getItem('HA_LAST_AUTO_DARK')==='true';
}
function onWeatherEnvelope(data){
  var instances=data&&data.instances||[];
  var props=instances[0]&&instances[0].properties||{};
  var sunrise=sunEpoch(props.sunrise),sunset=sunEpoch(props.sunset);
  if(!sunrise||!sunset||sunset<=sunrise)return;
  weatherSunrise=sunrise;weatherSunset=sunset;weatherUpdatedAt=Date.now();
  localStorage.setItem('HA_WEATHER_SUN_V1',JSON.stringify({
    sunrise:sunrise,sunset:sunset,savedAt:weatherUpdatedAt}));
  localStorage.setItem('HA_LAST_AUTO_DARK',String(effectiveThemeDark()));
  if(settingsReady&&effectiveThemeDark()!==themeDarkSent)sendWatchSettings(false);
}
function weatherSubscribe(){
  if(themeMode!=='auto'||typeof Pebble.subscribeToSource!=='function')return;
  if(weatherSource)return;
  try{
    weatherSource=Pebble.subscribeToSource({
      category:'weather',item:'location',plugin:WEATHER_PLUGIN_UUID,
      properties:['sunrise','sunset','updated_at'],
      onData:onWeatherEnvelope,
      onError:function(e){console.log('Weather+ auto theme unavailable: '+String(e&&e.code||'source error'));}
    });
  }catch(e){console.log('Weather+ subscription unavailable: '+String(e&&e.message||e));}
}
function weatherStop(){
  if(weatherSource&&typeof weatherSource.unsubscribe==='function')weatherSource.unsubscribe();
  weatherSource=null;
}
function updateWeatherSubscription(){
  if(themeMode==='auto')weatherSubscribe();else weatherStop();
}

var conversationId=localStorage.getItem('HA_CONVERSATION_ID')||'';
var requestGeneration=0,legacyConversationTurn=false,lastAnswer='';
var hasSpeaker=false;
try{
  var info=Pebble.getActiveWatchInfo();
  hasSpeaker=!!info&&(info.platform==='emery'||info.platform==='flint');
}catch(e){}
// Do not retain credentials from versions that connected directly.
['HA_URL','HA_TOKEN','HA_AGENT','HA_TTS','HA_PIPELINE','USE_HA_PLUGIN'].forEach(function(key){
  localStorage.removeItem(key);
});
var audio=require('./ha_audio').create({
  Pebble:Pebble,storage:localStorage,pluginId:HA_PLUGIN_UUID,
  diagnosticsKey:'HA_AUDIO_LIBRARY_DIAG_V1',
  onError:function(e){
    var message='Audio error: '+String(e&&e.message||e).substring(0,155);
    console.log(message);
    Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',
      TEXT:(lastAnswer+'\n\n'+message).substring(0,1900)});
    if(legacyConversationTurn){
      legacyConversationTurn=false;
      Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});
    }
  },
  onComplete:function(){
    if(legacyConversationTurn){
      legacyConversationTurn=false;
      Pebble.sendAppMessage({COMMAND:'CONV_AUDIO_END'});
    }
  }
});
function valueBoolean(value,fallback){
  if(value===true||value===1||value==='true'||value==='1')return true;
  if(value===false||value===0||value==='false'||value==='0')return false;
  return !!fallback;
}
var clayConfig=[
  {type:'heading',defaultValue:'Home Assistant AI'},
  {type:'section',items:[
    {type:'heading',defaultValue:'Display'},
    {type:'select',messageKey:'FONT_CHOICE',label:'Text size',
      defaultValue:fontChoice,
      options:[{label:'Normal',value:'normal'},{label:'Large',value:'large'}]},
    {type:'select',messageKey:'THEME_MODE',label:'Theme',
      defaultValue:themeMode,
      options:[{label:'Day',value:'day'},{label:'Night',value:'night'},
        {label:'Auto (Weather+)',value:'auto'}]},
    {type:'select',messageKey:'HAPTIC_LEVEL',label:'Vibration feedback',
      defaultValue:hapticLevel,
      options:[{label:'Off',value:'off'},{label:'Low',value:'low'},
        {label:'Medium',value:'medium'},{label:'High',value:'high'}]}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Home Assistant Bridge'},
    {type:'text',defaultValue:'Requires the Home Assistant Bridge plugin to be installed and configured.'},
    {type:'toggle',messageKey:'ENABLE_TTS',label:'Speak responses',
      defaultValue:enableTts},
    {type:'toggle',messageKey:'AUTO_SEND',label:'Send dictation automatically',
      defaultValue:autoSend},
    {type:'toggle',messageKey:'RESET_CHAT',label:'Start new conversation',
      defaultValue:false}
  ]},
  {type:'submit',defaultValue:'Save Settings'}
];
var clay=new Clay(clayConfig,null,{autoHandleEvents:false});
var favoriteConfigRows=[];
var CATALOG_CACHE_KEY='HA_CONTROLS_CACHE_V1';
var CATALOG_FETCH_AT_KEY='HA_CONTROLS_FETCHED_AT_V2';
var CATALOG_TTL_MS=60*60*1000;
var catalogPromise=null;
function storedIds(key){
  try {
    var ids=JSON.parse(localStorage.getItem(key)||'[]');
    return Array.isArray(ids)?ids.filter(function(v){return typeof v==='string';}):[];
  }catch(e){return [];}
}
function favoriteIds(){return storedIds('HA_FAVORITES_V1');}
function hiddenIds(){return storedIds('HA_HIDDEN_V1');}
function getCachedControls(){
  try {
    var rows=JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY)||'[]');
    return Array.isArray(rows)?rows:[];
  }catch(e){return [];}
}
function saveCachedControls(rows){
  localStorage.setItem(CATALOG_CACHE_KEY,JSON.stringify(rows));
  localStorage.setItem(CATALOG_FETCH_AT_KEY,String(Date.now()));
}
function fetchControlsIfStale(force){
  var cached=getCachedControls();
  var age=Date.now()-Number(localStorage.getItem(CATALOG_FETCH_AT_KEY)||0);
  if(!force&&cached.length&&age>=0&&age<CATALOG_TTL_MS)return Promise.resolve(cached);
  if(catalogPromise)return catalogPromise;
  catalogPromise=pluginAction('list_controls',{}).then(function(result){
    var rows=pluginJson(result);
    if(!Array.isArray(rows))throw Error('Bridge returned no controllable entities');
    saveCachedControls(rows);
    return rows;
  }).then(function(rows){catalogPromise=null;return rows;},function(err){
    catalogPromise=null;
    if(cached.length){console.log('Using cached controls: '+String(err&&err.message||err));return cached;}
    throw err;
  });
  return catalogPromise;
}
function controlKind(domain){
  return {light:1,switch:2,input_boolean:2,fan:3,cover:4,scene:5,script:6,automation:7}[domain]||0;
}
function isRunAction(domain){return /^(scene|script|automation)$/.test(String(domain||''));}
function displayState(row){
  // A scene/script activation is an action, not an entity being switched on.
  return isRunAction(row.domain)?'Run':String(row.state||'unknown');
}
function configureWithDevices(rows){
  var cfg=clayConfig.slice();
  var favorites=favoriteIds(),hidden=hiddenIds();
  favoriteConfigRows=rows.slice().sort(function(a,b){
    return String(a.room||'').localeCompare(String(b.room||''))||
      String(a.name||'').localeCompare(String(b.name||''));
  }).slice(0,48);
  var items=[
    {type:'heading',defaultValue:'Watch devices'},
    {type:'text',defaultValue:'Favorite adds to Favorites; Hide removes an item from all watch lists. Hidden favorites stay saved.'},
    {type:'toggle',messageKey:'REFRESH_DEVICES',label:'Refresh devices and rooms',
      defaultValue:false},
    {type:'text',defaultValue:
      '<style>'+
      '.component-checkbox>.label{font-weight:600;padding-bottom:4px;}'+
      '.component-checkbox .checkbox-group{display:flex;gap:4px;padding-bottom:2px;}'+
      '.component-checkbox .checkbox-group label{display:flex;flex:1;min-width:0;flex-direction:row-reverse;justify-content:flex-end;align-items:center;gap:8px;padding:7px 2px;}'+
      '.component-checkbox .checkbox-group .label{font-size:0.9em;white-space:nowrap;}'+
      '.component-checkbox .checkbox-group i{width:23px;height:23px;flex-shrink:0;}'+
      '</style>'}
  ];
  var previousRoom='';
  favoriteConfigRows.forEach(function(r,i){
    var room=String(r.room||'Unassigned');
    if(room!==previousRoom){
      previousRoom=room;
      items.push({type:'heading',defaultValue:room.slice(0,36)});
    }
    // Native Clay checkbox group: a single device row with two independent
    // options. The DEV_i[2] app-message keys are reserved in package.json;
    // values are intercepted on webviewclosed and never sent to the watch.
    items.push({
      type:'checkboxgroup',
      messageKey:'DEV_'+i,
      label:escapeSettingsText(String(r.name||r.id).slice(0,65)),
      defaultValue:[favorites.indexOf(r.id)>=0,hidden.indexOf(r.id)>=0],
      options:['Favorite','Hide']
    });
  });
  if(!favoriteConfigRows.length)
    items.push({type:'text',defaultValue:'No cached devices yet. Open Devices by Room on the watch, then reopen Settings.'});
  // Display and Bridge first, then the grouped per-device controls.
  cfg.splice(cfg.length-1,0,{type:'section',items:items});
  clay=new Clay(cfg,null,{autoHandleEvents:false});
  Pebble.openURL(clay.generateUrl());
}
function escapeSettingsText(value){
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
Pebble.addEventListener('showConfiguration',function(){
  // Opening settings must not require a network call, especially on Android.
  var cached=getCachedControls();
  if(cached.length){
    configureWithDevices(cached);
    // Refresh metadata for a future settings visit if the cache expired.
    fetchControlsIfStale(false).catch(function(e){console.log('Device refresh: '+String(e&&e.message||e));});
    return;
  }
  // Cold first install: bounded discovery, then always open basic settings.
  var opened=false;
  function openOnce(rows){if(opened)return;opened=true;configureWithDevices(rows);}
  setTimeout(function(){openOnce([]);},2500);
  fetchControlsIfStale(true).then(openOnce).catch(function(err){
    console.log('Initial device discovery: '+String(err&&err.message||err));
    openOnce([]);
  });
});
function sendWatchSettings(preview){
  var dark=effectiveThemeDark();
  themeDarkSent=dark;
  if(themeMode==='auto'&&weatherSunrise&&weatherSunset)
    localStorage.setItem('HA_LAST_AUTO_DARK',String(dark));
  Pebble.sendAppMessage({COMMAND:'SETTINGS',FONT_SIZE:fontChoice==='large'?28:24,
    LARGE_TEXT:fontChoice==='large'?1:0,THEME_DARK:dark?1:0,
    AUTO_SEND:autoSend?1:0,HAPTIC_LEVEL:hapticValues[hapticLevel]||0},
    function(){
      if(preview)Pebble.sendAppMessage({COMMAND:'HAPTIC_PREVIEW',
        HAPTIC_LEVEL:hapticValues[hapticLevel]||0});
    },function(err){console.log('Watch settings: '+JSON.stringify(err));});
}
Pebble.addEventListener('webviewclosed',function(e){
  if(!e||!e.response||e.response==='CANCELLED')return;
  var fields;
  try{fields=JSON.parse(decodeURIComponent(e.response));}catch(err){return;}
  function field(k){return fields[k]?fields[k].value:undefined;}
  if(favoriteConfigRows.length){
    var chosen=favoriteIds(),hidden=hiddenIds(),visibilityChanged=false;
    favoriteConfigRows.forEach(function(r,i){
      var selections=field('DEV_'+i);
      // Raw Clay checkboxgroup responses use {value:[true,false]}.
      // Also tolerate 1/0 values, and leave existing preferences unchanged
      // when a field is absent (e.g., a cancelled or partial config page).
      if(!Array.isArray(selections)||selections.length<2)return;
      var oldFavorite=chosen.indexOf(r.id)>=0;
      var oldHidden=hidden.indexOf(r.id)>=0;
      var newFavorite=valueBoolean(selections[0],false);
      var newHidden=valueBoolean(selections[1],false);
      if(newFavorite!==oldFavorite||newHidden!==oldHidden)visibilityChanged=true;
      chosen=chosen.filter(function(id){return id!==r.id;});
      hidden=hidden.filter(function(id){return id!==r.id;});
      if(newFavorite)chosen.push(r.id);
      if(newHidden)hidden.push(r.id);
    });
    localStorage.setItem('HA_FAVORITES_V1',JSON.stringify(chosen));
    localStorage.setItem('HA_HIDDEN_V1',JSON.stringify(hidden));
    if(visibilityChanged){
      // One small invalidation instead of retransmitting every room/device.
      Pebble.sendAppMessage({COMMAND:'CTRL_INVALIDATE'},null,function(){});
    }
  }
  if(valueBoolean(field('REFRESH_DEVICES'),false)){
    localStorage.removeItem(CATALOG_FETCH_AT_KEY);
    Pebble.sendAppMessage({COMMAND:'CTRL_INVALIDATE'},null,function(){});
  }
  if(field('ENABLE_TTS')!==undefined){
    enableTts=valueBoolean(field('ENABLE_TTS'),enableTts);
    localStorage.setItem('ENABLE_TTS',String(enableTts));
  }
  if(field('AUTO_SEND')!==undefined){
    autoSend=valueBoolean(field('AUTO_SEND'),autoSend);
    localStorage.setItem('AUTO_SEND',String(autoSend));
  }
  if(field('RESET_CHAT')!==undefined && valueBoolean(field('RESET_CHAT'),false)){
    conversationId='';localStorage.removeItem('HA_CONVERSATION_ID');
  }
  if(field('FONT_CHOICE')!==undefined){
    fontChoice=String(field('FONT_CHOICE'))==='large'?'large':'normal';
    localStorage.setItem('FONT_CHOICE',fontChoice);
    localStorage.setItem('FONT_SIZE',String(fontChoice==='large'?28:24));
  }
  if(field('THEME_MODE')!==undefined){
    var value=String(field('THEME_MODE'));
    themeMode=/^(day|night|auto)$/.test(value)?value:'auto';
    localStorage.setItem('HA_THEME_MODE',themeMode);
    updateWeatherSubscription();
  }
  if(field('HAPTIC_LEVEL')!==undefined){
    var next=String(field('HAPTIC_LEVEL'));
    if(hapticValues.hasOwnProperty(next)){
      var preview=next!==hapticLevel;
      hapticLevel=next;localStorage.setItem('HAPTIC_LEVEL',next);
      sendWatchSettings(preview);return;
    }
  }
  sendWatchSettings(false);
});
Pebble.addEventListener('ready',function(){
  settingsReady=true;
  sendWatchSettings(false);
  updateWeatherSubscription();
  // Check for sunrise/sunset transitions without refreshing the weather
  // feed or redrawing the watch unnecessarily.
  setInterval(function(){
    if(themeMode==='auto'&&effectiveThemeDark()!==themeDarkSent)sendWatchSettings(false);
  },15*60*1000);
});
function pluginAction(action,args){
  return Pebble.invokeAction({plugin:HA_PLUGIN_UUID,action:action,args:args});
}
function pluginJson(result){
  if(!result||!result.ok)
    throw Error(String(result&&result.message||'Home Assistant Bridge is unavailable or permission was denied'));
  try{return JSON.parse(result.text||'{}');}
  catch(e){throw Error('Invalid Home Assistant Bridge response');}
}
function replyError(message,legacy){
  audio.stop();
  Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',
    TEXT:String(message).substring(0,1900)},function(){
    if(legacy)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
  });
}
function askViaBridge(text,legacy,mute){
  var gen=++requestGeneration;
  legacyConversationTurn=!!legacy;
  audio.stop();
  var args={text:String(text)};
  if(conversationId)args.conversation_id=conversationId;
  pluginAction('conversation',args).then(function(result){
    if(gen!==requestGeneration)return;
    var data=pluginJson(result);
    if(data.conversation_id){
      conversationId=String(data.conversation_id);
      localStorage.setItem('HA_CONVERSATION_ID',conversationId);
    }
    lastAnswer=String(data.text||'No spoken response returned by Home Assistant.');
    var speak=hasSpeaker&&enableTts&&!mute;
    Pebble.sendAppMessage({
      COMMAND:speak?'TEXT_RESPONSE_8_16':'TEXT_RESPONSE_NO_AUDIO',
      TEXT:lastAnswer.substring(0,1900)
    },function(){
      if(gen!==requestGeneration)return;
      if(!speak){
        if(legacy)Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});
        legacyConversationTurn=false;
        return;
      }
      audio.speak(lastAnswer).catch(function(e){
        if(gen===requestGeneration)replyError('Audio: '+String(e.message||e),legacy);
      });
    },function(){if(gen===requestGeneration)replyError('Watch response unavailable',legacy);});
  }).catch(function(e){
    if(gen===requestGeneration)replyError('Bridge: '+String(e.message||e),legacy);
  });
}

var controlRows=[];
var LAST_REV_KEY='HA_WATCH_CATALOG_REV_V2',LAST_STATES_KEY='HA_WATCH_STATES_V2';
var WATCH_IDS_KEY='HA_WATCH_IDS_V2';
function loadSentStates(){
  try {var data=JSON.parse(localStorage.getItem(LAST_STATES_KEY)||'{}');
    return data&&typeof data==='object'?data:{};}catch(e){return {};}
}
function normalizeCatalog(rows){
  var favorites=favoriteIds(),hidden=hiddenIds();
  return rows.filter(function(r){return r&&typeof r.id==='string'&&hidden.indexOf(r.id)<0;})
    .sort(function(a,b){
      return String(a.room||'').localeCompare(String(b.room||''))||
        String(a.name||'').localeCompare(String(b.name||''))||
        String(a.id).localeCompare(String(b.id));
    }).slice(0,48).map(function(r){
      return {id:r.id,name:r.name,room:r.room,domain:r.domain,
        state:displayState(r),favorite:favorites.indexOf(r.id)>=0};
    });
}
function catalogRevision(rows){
  // Keep dynamic states out of this hash: on/off changes send tiny deltas.
  var text='HA-WATCH-CATALOG-V2|'+rows.map(function(r){
    return [r.id,r.name,r.room,r.domain,r.favorite?'1':'0'].join('|');
  }).join('\n'),hash=5381;
  for(var i=0;i<text.length;i++)hash=((hash*33)^text.charCodeAt(i))|0;
  return hash||1;
}
function controlSend(message,next,attempt){
  attempt=attempt||0;
  Pebble.sendAppMessage(message,function(){if(next)next(true);},function(err){
    if(attempt<2){
      setTimeout(function(){controlSend(message,next,attempt+1);},220*(attempt+1));
    }else{
      console.log('Control transport failed after 3 tries: '+JSON.stringify(err));
      if(next)next(false);
    }
  });
}
function controlRow(r,index){
  return {COMMAND:'CTRL_ROW',CTRL_INDEX:index,
    CTRL_NAME:String(r.name||'Device').slice(0,35),
    CTRL_STATUS:String(r.state||'unknown').slice(0,11),
    CTRL_ROOM:String(r.room||'Unassigned').slice(0,21),
    CTRL_KIND:controlKind(r.domain),CTRL_FAV:r.favorite?1:0};
}
function sendCatalog(watchRevision,rows){
  controlRows=normalizeCatalog(rows);
  var revision=catalogRevision(controlRows);
  var lastSentRev=Number(localStorage.getItem(LAST_REV_KEY)||0);
  var sentStates=loadSentStates();
  var full=watchRevision!==revision||lastSentRev!==revision;
  var packets=[];
  controlRows.forEach(function(r,i){
    if(full)packets.push(controlRow(r,i));
    else if(sentStates[r.id]!==r.state)
      packets.push({COMMAND:'CTRL_STATE',CTRL_INDEX:i,CTRL_STATUS:String(r.state).slice(0,26)});
  });
  var nextStates={};
  controlRows.forEach(function(r){nextStates[r.id]=r.state;});
  function sendAt(i){
    if(i===packets.length){
      controlSend({COMMAND:'CTRL_DONE',CTRL_TOTAL:controlRows.length,CTRL_REV:revision},
        function(ok){
          if(!ok)return;
          localStorage.setItem(LAST_REV_KEY,String(revision));
          localStorage.setItem(LAST_STATES_KEY,JSON.stringify(nextStates));
          localStorage.setItem(WATCH_IDS_KEY,JSON.stringify(controlRows.map(function(r){return r.id;})));
        });
      return;
    }
    controlSend(packets[i],function(ok){
      if(ok)sendAt(i+1);
      else controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:'Sync interrupted'});
    });
  }
  sendAt(0);
}
function controlLoad(watchRevision){
  fetchControlsIfStale(false).then(function(rows){
    sendCatalog(Number(watchRevision)||0,rows);
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}
function controlAct(index){
  // The watch can operate entirely from its persistent cache. Resolve the
  // selected index against the LAST acknowledged watch catalog, even after
  // PebbleKit JS restarts and before any new Bluetooth catalog request.
  var ids=[];
  try{ids=JSON.parse(localStorage.getItem(WATCH_IDS_KEY)||'[]');}catch(e){}
  var id=ids[index]||(controlRows[index]&&controlRows[index].id);
  if(!id){
    // A phone reinstall can clear the index mapping while the watch cache
    // remains populated. Invalidate the catalog instead of acting on a guess.
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:'Reload devices'});
    controlSend({COMMAND:'CTRL_INVALIDATE'});
    return;
  }
  var r=getCachedControls().filter(function(x){return x.id===id;})[0]||
    controlRows.filter(function(x){return x.id===id;})[0];
  if(!r)return;
  pluginAction('control_entity',{entity_id:id}).then(function(result){
    pluginJson(result);
    if(isRunAction(r.domain)){
      // Scenes, scripts and one-shot automation triggers have no toggle state.
      controlSend({COMMAND:'CTRL_ACTION_DONE',CTRL_STATUS:'Triggered'});
      return null;
    }
    return pluginAction('get_state',{entity_id:r.id});
  }).then(function(result){
    if(!result)return;
    var fresh=pluginJson(result);
    if(fresh&&fresh.state!==undefined){
      r.state=String(fresh.state);
      var all=getCachedControls();
      all.forEach(function(x){if(x.id===r.id)x.state=r.state;});
      // This changes only the local phone cache, not its discovery age.
      localStorage.setItem(CATALOG_CACHE_KEY,JSON.stringify(all));
      var states=loadSentStates();
      states[r.id]=r.state;
      localStorage.setItem(LAST_STATES_KEY,JSON.stringify(states));
      controlSend({COMMAND:'CTRL_STATE',CTRL_INDEX:index,
        CTRL_STATUS:String(r.state).slice(0,11)},function(ok){
        if(ok)controlSend({COMMAND:'CTRL_ACTION_DONE',CTRL_STATUS:'Updated'});
      });
    }
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}

Pebble.addEventListener('appmessage',function(event){
  var d=event.payload||{};
  if(audio.handleMessage(d))return;
  if(d.COMMAND==='CTRL_REQUEST'){controlLoad(Number(d.CTRL_REV)||0);return;}
  if(d.COMMAND==='CTRL_ACT'){controlAct(Number(d.CTRL_INDEX));return;}
  if(d.COMMAND!=='DICTATION'&&d.COMMAND!=='CONV_DICTATION')return;
  var legacy=d.COMMAND==='CONV_DICTATION';
  if(!d.TEXT){replyError('No dictation captured',legacy);return;}
  askViaBridge(d.TEXT,legacy,d.VOLUME===0);
});
