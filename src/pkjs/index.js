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
  if(settingsReady)sendWatchSettings(false);
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
    {type:'heading',defaultValue:'Home Assistant Bridge required'},
    {type:'text',defaultValue:'Install and configure the Home Assistant Bridge plugin. This app uses the Bridge exclusively for conversations and speech; there is no direct connection or separate token.'},
    {type:'toggle',messageKey:'ENABLE_TTS',label:'Speak responses on watch',
      defaultValue:enableTts},
    {type:'toggle',messageKey:'AUTO_SEND',label:'Send dictation without confirmation',
      defaultValue:autoSend},
    {type:'toggle',messageKey:'RESET_CHAT',label:'Start new conversation',
      defaultValue:false}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Latest Bridge and watch audio diagnostics'},
    {type:'text',id:'pcm_debug_display',defaultValue:'Ask Home Assistant a question and reopen Settings.'}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Display'},
    {type:'select',messageKey:'FONT_CHOICE',label:'Text size',
      defaultValue:fontChoice,
      options:[{label:'Normal',value:'normal'},{label:'Large',value:'large'}]},
    {type:'select',messageKey:'THEME_MODE',label:'Theme',
      defaultValue:themeMode,
      options:[{label:'Day',value:'day'},{label:'Night',value:'night'},
        {label:'Auto (Weather+ sunrise/sunset)',value:'auto'}]},
    {type:'text',defaultValue:'Auto requires Weather+ installed. Without solar times, the last known appearance is retained.'},
    {type:'select',messageKey:'HAPTIC_LEVEL',label:'Vibration feedback',
      defaultValue:hapticLevel,
      options:[{label:'Off',value:'off'},{label:'Low - short',value:'low'},
        {label:'Medium - double',value:'medium'},{label:'High - long',value:'high'}]}
  ]},
  {type:'submit',defaultValue:'Save Settings'}
];
var clay=new Clay(clayConfig,null,{autoHandleEvents:false});
function diagnosticsText(){
  var d=audio.diagnostics(),watch=null;
  try{watch=JSON.parse(localStorage.getItem('HA_AUDIO_LIBRARY_DIAG_V1_WATCH')||'null');}catch(e){}
  var lines=['Connection: Home Assistant Bridge plugin'];
  if(!d)lines.push('No TTS request recorded yet.');
  else {
    lines.push('Captured: '+(d.timestamp||'unknown'));
    lines.push('Transfer: '+(d.transfer||'pending'));
    if(d.source)lines.push('Source: '+d.source);
    if(d.engine_id)lines.push('TTS engine: '+d.engine_id);
    if(d.stage_ms){
      lines.push('HA generation: '+d.stage_ms.ha_generation+' ms');
      lines.push('Binary fetch: '+d.stage_ms.binary_download+' ms');
      lines.push('WAV processing: '+d.stage_ms.total_bridge+' ms');
    }
    if(d.first_audio_queued_ms!==undefined)
      lines.push('First audio queued: '+d.first_audio_queued_ms+' ms');
    if(d.prepare_ms!==undefined)lines.push('TTS prepare: '+d.prepare_ms+' ms');
    if(d.chunk_transfer_ms!==undefined)lines.push('WAV chunks: '+d.chunk_transfer_ms+' ms');
    if(d.total_wav_ms!==undefined)lines.push('Total WAV: '+d.total_wav_ms+' ms');
    if(d.error)lines.push('Error: '+d.error);
  }
  if(watch){
    lines.push('Watch playback at '+watch.timestamp+':');
    lines.push('Empty events: '+watch.empty+'; empty ms: '+watch.empty_ms);
    lines.push('Partial writes: '+watch.partial+'; zero writes: '+watch.zero);
    lines.push('Peak ADPCM ring: '+watch.peak+' B');
  }
  return '<div style="white-space:pre-wrap;word-break:break-word;font-size:13px">'+
    lines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;')+'</div>';
}
var favoriteConfigRows=[];
function favoriteIds(){
  try { var ids=JSON.parse(localStorage.getItem('HA_FAVORITES_V1')||'[]');
    return Array.isArray(ids)?ids.filter(function(v){return typeof v==='string';}):[];
  } catch(e){return [];}
}
function controlKind(domain){
  return {light:1,switch:2,input_boolean:2,fan:3,cover:4,scene:5,script:6,automation:7}[domain]||0;
}
function configureWithDevices(rows){
  var cfg=clayConfig.slice();
  var favoriteSet=favoriteIds();
  favoriteConfigRows=rows.slice(0,48);
  var items=[
    {type:'heading',defaultValue:'Favorite devices'},
    {type:'text',defaultValue:'Choose devices for the Favorites menu on the watch. Changes apply next time you open the list.'}
  ];
  var previousRoom='';
  favoriteConfigRows.forEach(function(r,i){
    if(r.room!==previousRoom){
      previousRoom=r.room;
      items.push({type:'heading',defaultValue:String(r.room||'Unassigned').slice(0,36)});
    }
    items.push({type:'toggle',messageKey:'FAV_'+i,
      label:String(r.name||r.id).slice(0,65),defaultValue:favoriteSet.indexOf(r.id)>=0});
  });
  if(!favoriteConfigRows.length){
    items.push({type:'text',defaultValue:'No devices loaded. Configure Home Assistant Bridge and reopen Settings.'});
  }
  cfg.splice(1,0,{type:'section',items:items});
  cfg.forEach(function(section){
    if(!section.items)return;
    section.items.forEach(function(item){
      if(item.id==='pcm_debug_display')item.defaultValue=diagnosticsText();
    });
  });
  clay=new Clay(cfg,null,{autoHandleEvents:false});
  Pebble.openURL(clay.generateUrl());
}
Pebble.addEventListener('showConfiguration',function(){
  // A hung Bridge action must never block the app's configuration page.
  // Show last-known devices, or at least basic settings, after 2.5 seconds.
  var opened=false;
  var fallback=[];
  try {
    fallback=JSON.parse(localStorage.getItem('HA_CONTROLS_CACHE_V1')||'[]');
    if(!Array.isArray(fallback))fallback=[];
  }catch(e){fallback=[];}
  function openOnce(rows){
    if(opened)return;
    opened=true;
    configureWithDevices(rows);
  }
  setTimeout(function(){openOnce(fallback);},2500);
  pluginAction('list_controls',{}).then(function(result){
    var rows=pluginJson(result);
    if(!Array.isArray(rows))throw Error('No devices');
    rows.sort(function(a,b){
      var room=String(a.room||'').localeCompare(String(b.room||''));
      return room||String(a.name||'').localeCompare(String(b.name||''));
    });
    localStorage.setItem('HA_CONTROLS_CACHE_V1',JSON.stringify(rows));
    openOnce(rows);
  }).catch(function(err){
    console.log('Favorites discovery: '+String(err&&err.message||err));
    openOnce(fallback);
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
    var chosen=favoriteIds();
    favoriteConfigRows.forEach(function(r,i){
      var value=field('FAV_'+i);
      if(value===undefined)return;
      chosen=chosen.filter(function(id){return id!==r.id;});
      if(valueBoolean(value,false))chosen.push(r.id);
    });
    localStorage.setItem('HA_FAVORITES_V1',JSON.stringify(chosen));
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
function controlSend(message,next){
  Pebble.sendAppMessage(message,function(){if(next)next();},function(err){
    console.log('Control row transport failed '+JSON.stringify(err));
    if(next)setTimeout(next,180);
  });
}
function visibleControls(rows,mode){
  var fav=favoriteIds();
  return rows.filter(function(r){
    if(mode===1)return fav.indexOf(r.id)>=0;
    if(mode===2)return /^(scene|script|automation)$/.test(r.domain);
    return true;
  }).sort(function(a,b){
    if(mode===0){
      var af=fav.indexOf(a.id)>=0,bf=fav.indexOf(b.id)>=0;
      if(af!==bf)return af?-1:1;
    }
    return String(a.room||'').localeCompare(String(b.room||''))||
      String(a.name||'').localeCompare(String(b.name||''));
  }).slice(0,48);
}
function controlRow(r,index){
  var fav=favoriteIds();
  return {COMMAND:'CTRL_ROW',CTRL_INDEX:index,CTRL_ID:String(r.id||'').slice(0,62),
    CTRL_NAME:String(r.name||'Device').slice(0,46),
    CTRL_STATUS:String(r.state||'unknown').slice(0,26),
    CTRL_ROOM:String(r.room||'Unassigned').slice(0,30),
    CTRL_KIND:controlKind(r.domain),CTRL_FAV:fav.indexOf(r.id)>=0?1:0};
}
function controlLoad(mode){
  pluginAction('list_controls',{}).then(function(result){
    var rows=pluginJson(result);
    if(!Array.isArray(rows))throw Error('Bridge returned no controllable entities');
    localStorage.setItem('HA_CONTROLS_CACHE_V1',JSON.stringify(rows));
    controlRows=visibleControls(rows,mode);
    var i=0;
    function sendNext(){
      if(i>=controlRows.length){controlSend({COMMAND:'CTRL_DONE'});return;}
      var index=i++;
      controlSend(controlRow(controlRows[index],index),sendNext);
    }
    sendNext();
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}
function controlAct(index){
  var r=controlRows[index];
  if(!r)return;
  pluginAction('control_entity',{entity_id:r.id}).then(function(result){
    pluginJson(result);
    return pluginAction('get_state',{entity_id:r.id});
  }).then(function(result){
    var fresh=pluginJson(result);
    if(fresh&&fresh.state!==undefined){
      r.state=String(fresh.state);
      controlSend(controlRow(r,index));
    }
    controlSend({COMMAND:'CTRL_DONE'});
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}

Pebble.addEventListener('appmessage',function(event){
  var d=event.payload||{};
  if(audio.handleMessage(d))return;
  if(d.COMMAND==='CTRL_REQUEST'){controlLoad(Number(d.CTRL_INDEX)||0);return;}
  if(d.COMMAND==='CTRL_ACT'){controlAct(Number(d.CTRL_INDEX));return;}
  if(d.COMMAND!=='DICTATION'&&d.COMMAND!=='CONV_DICTATION')return;
  var legacy=d.COMMAND==='CONV_DICTATION';
  if(!d.TEXT){replyError('No dictation captured',legacy);return;}
  askViaBridge(d.TEXT,legacy,d.VOLUME===0);
});
