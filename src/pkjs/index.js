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
var weatherTheme;
function updateWeatherSubscription() {
  if (!weatherTheme) weatherTheme = require('./theme-weather').create(Pebble, require('message_keys'));
  weatherTheme.setAuto(themeMode === 'auto');
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
  {type: 'section', items: [
    {type: 'heading', defaultValue: 'Appearance'},
    {type: 'select', messageKey: 'THEME_MODE', label: 'Theme', defaultValue: themeMode,
      description: 'Auto follows sunrise and sunset. Without saved times, Day runs from 7 a.m. to 7 p.m.',
      options: [
        {label: 'Day', value: 'day'},
        {label: 'Night', value: 'night'},
        {label: 'Auto', value: 'auto'}
      ]}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Display'},
    {type:'select',messageKey:'FONT_CHOICE',label:'Text size',
      defaultValue:fontChoice,
      options:[{label:'Normal',value:'normal'},{label:'Large',value:'large'}]},
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
var favoriteConfigGroups=[];

var CATALOG_CACHE_KEY='HA_CONTROLS_CACHE_V1';
var CATALOG_FETCH_AT_KEY='HA_CONTROLS_FETCHED_AT_V2';
var CATALOG_TTL_MS=60*60*1000;
var ROOM_CACHE_FORMAT_KEY='HA_ROOM_CACHE_FORMAT';
if(localStorage.getItem(ROOM_CACHE_FORMAT_KEY)!=='json_rooms_v2'){
  // Old Bridge metadata could incorrectly assign every device to Unassigned.
  // Clear only the catalog; retain Favorite/Hide and other user preferences.
  localStorage.removeItem('HA_CONTROLS_CACHE_V1');
  localStorage.removeItem('HA_CONTROLS_FETCHED_AT_V2');
  localStorage.setItem(ROOM_CACHE_FORMAT_KEY,'json_rooms_v2');
}
var PAGE_SIZE=32;
var currentWatchMode=0,currentWatchOffset=0;
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
  // Retrieve all 48-entity Bridge discovery pages. Only a finite page
  // is transmitted to the watch; the phone catalog has no device cap.
  function getPage(offset,all,seen){
    return pluginAction('list_controls',{offset:offset,metadata_only:true}).then(function(result){
      var page=pluginJson(result);
      if(!Array.isArray(page))throw Error('Bridge returned no controllable entities');
      var added=0;
      page.forEach(function(row){
        if(row&&row.id&&!seen[row.id]){
          seen[row.id]=true;all.push(row);added++;
        }
      });
      // Older plugin versions ignore offset and repeat the first page.
      if(page.length===48&&added>0)
        return getPage(offset+48,all,seen);
      return all;
    });
  }
  catalogPromise=getPage(0,[],{}).then(function(rows){
    saveCachedControls(rows.map(function(r){return {id:r.id,name:r.name,room:r.room,domain:r.domain};}));
    return getCachedControls();
  }).then(function(rows){catalogPromise=null;return rows;},function(err){
    catalogPromise=null;
    if(!force&&cached.length){console.log('Using cached controls: '+String(err&&err.message||err));return cached;}
    throw err;
  });
  return catalogPromise;
}
function isFanControl(row){
  if(!row)return false;
  if(row.domain==='fan')return true;
  if(row.domain!=='switch'&&row.domain!=='input_boolean')return false;
  var re=/(^|[^a-z0-9])(fan|fans|vent|ventilator|ventilation|exhaust|air[._ -]*handler)(?=$|[^a-z0-9])/i;
  return re.test(String(row.name||''))||re.test(String(row.id||''));
}
function isLightControl(row){
  if(!row)return false;
  if(row.domain==='light')return true;
  if(row.domain!=='switch'&&row.domain!=='input_boolean')return false;
  // Some relay-backed fixtures are exposed as switch.* even though their
  // physical device is a light. Prefer known entity_id and friendly name.
  var re=/(^|[^a-z0-9])(light|lights|lamp|lamps|bulb|bulbs|lighting|chandelier|sconce|dimmer)(?=$|[^a-z0-9])/i;
  return re.test(String(row.name||''))||re.test(String(row.id||''));
}
function controlKind(domain,name,id){
  var row={domain:domain,name:name,id:id};
  if(isFanControl(row))return 3;
  if(isLightControl(row))return 1;
  if(domain==='lock')return 13;
  if(domain==='cover'&&/(garage|door)/i.test(String(name||'')+' '+String(id||'')))return 14;
  return {switch:2,input_boolean:2,cover:4,scene:5,script:6,automation:7}[domain]||0;
}
function isRunAction(domain){return /^(scene|script|automation)$/.test(String(domain||''));}
function displayState(row){
  // A scene/script activation is an action, not an entity being switched on.
  return isRunAction(row.domain)?'Run':String(row.state||'unknown');
}
// Render state/capability details without changing the raw HA state used by icons.
function deviceStatusSubtitle(row,fresh){
  if(isRunAction(row.domain))return 'Tap to run';
  var raw=String(fresh&&fresh.state!==undefined?fresh.state:'unknown');
  var key=raw.toLowerCase();
  var labels={on:'On',off:'Off',open:'Open',closed:'Closed',opening:'Opening',
    closing:'Closing',locked:'Locked',unlocked:'Unlocked',
    unknown:'Unknown',unavailable:'Unavailable'};
  var label=Object.prototype.hasOwnProperty.call(labels,key)?labels[key]:
    raw.charAt(0).toUpperCase()+raw.slice(1);
  if(key==='unknown'||key==='unavailable')return label;
  var a=fresh&&fresh.attributes||{},domain=row.domain;
  var parts=[label],percentage=null;
  function percent(value){return Math.max(0,Math.min(100,Math.round(value)));}
  if(key!=='off'&&domain==='light'&&typeof a.brightness==='number')
    percentage=percent(a.brightness*100/255);
  else if(key!=='off'&&domain==='fan'&&typeof a.percentage==='number')
    percentage=percent(a.percentage);
  else if(domain==='cover'&&typeof a.current_position==='number')
    percentage=percent(a.current_position);
  if(percentage!==null)parts.push(percentage+'%');
  if(domain==='light'&&key==='on'){
    var color='';
    if(typeof a.color_name==='string'&&a.color_name.trim())
      color=a.color_name.trim();
    else if(Array.isArray(a.rgb_color)&&a.rgb_color.length===3&&
      a.rgb_color.every(function(v){return typeof v==='number'&&isFinite(v);}))
      color='#'+a.rgb_color.map(function(v){
        return ('0'+Math.max(0,Math.min(255,Math.round(v))).toString(16)).slice(-2);
      }).join('').toUpperCase();
    else if(typeof a.color_temp_kelvin==='number'&&a.color_temp_kelvin>0)
      color=Math.round(a.color_temp_kelvin)+'K';
    else if(typeof a.color_temp==='number'&&a.color_temp>0)
      color=Math.round(1000000/a.color_temp)+'K';
    if(color)parts.push(color);
  }
  return parts.join(' · ').slice(0,39);
}
// The room header already supplies location. HA sometimes gives a fan and
// light the identical friendly_name (e.g. both "Annie Cave"). Use the entity
// domain to disambiguate instead of editing their Home Assistant entity IDs.
function displayDeviceName(row){
  var original=String(row.name||row.id||'Device').trim();
  var room=String(row.room||'').trim();
  var tail=original;
  if(room&&room.toLowerCase()!=='unassigned'){
    if(original.toLowerCase()===room.toLowerCase())tail='';
    else if(original.toLowerCase().indexOf(room.toLowerCase()+' ')===0)
      tail=original.slice(room.length).trim();
    else if(original.toLowerCase().indexOf(room.toLowerCase()+' - ')===0)
      tail=original.slice(room.length+3).trim();
  }
  if(!tail){
    var domain=String(row.domain||'').toLowerCase();
    if(isFanControl(row))return 'Fan';
    if(isLightControl(row))return 'Light';
    if(domain==='switch')return 'Switch';
    if(domain==='input_boolean')return 'Toggle';
    if(domain==='cover')return /garage|door/i.test(String(row.id))?'Garage Door':'Cover';
    if(domain==='lock')return 'Lock';
    if(domain==='scene')return 'Scene';
    if(domain==='script')return 'Script';
    if(domain==='automation')return 'Automation';
    return original;
  }
  return tail;
}
function deduplicateControlGroups(rows){
  var favorites=favoriteIds(),hidden=hiddenIds(),byId={},ids=[];
  (rows||[]).forEach(function(r){
    if(!r||!r.id)return;
    var key=String(r.id).toLowerCase();
    if(!byId[key])ids.push(key);
    byId[key]=r; // Collapse identical entity IDs returned on multiple pages.
  });
  var groups={},keys=[];
  ids.forEach(function(id){
    var r=byId[id];
    // Match room-relative label AND effective device type. A fan and light
    // both named "Annie Cave" are never the same control.
    var room=String(r.room||'Unassigned').trim().toLowerCase();
    var label=displayDeviceName(r).trim().toLowerCase();
    var kind=controlKind(r.domain,r.name,r.id);
    var key=room+'|'+label+'|'+kind;
    if(!groups[key]){groups[key]=[];keys.push(key);}
    groups[key].push(r);
  });
  return keys.map(function(key){
    var members=groups[key];
    function rank(r){
      // A visible alias must win over a hidden one, even if the hidden
      // alias was previously marked Favorite.
      var favored=favorites.indexOf(r.id)>=0?100:0;
      var visible=hidden.indexOf(r.id)<0?200:0;
      // Prefer direct HA light/fan entities over switch-powered mirrors.
      var nativeKind=controlKind(r.domain,r.name,r.id);
      var native=(nativeKind===1&&r.domain==='light')||
        (nativeKind===3&&r.domain==='fan');
      return favored+visible+(native?10:0);
    }
    var representative=members[0];
    members.forEach(function(r){
      if(rank(r)>rank(representative)||
        (rank(r)===rank(representative)&&r.id<representative.id))
        representative=r;
    });
    return {row:representative,ids:members.map(function(r){return r.id;})};
  });
}
function deduplicateControls(rows){
  return deduplicateControlGroups(rows).map(function(group){return group.row;});
}
function configureWithDevices(rows){
  var cfg=clayConfig.slice();
  var favorites=favoriteIds(),hidden=hiddenIds();
  // Distinct IDs can produce duplicate Home Assistant rows (an exposed
  // helper and its mirrored entity). Prefer explicitly favorited records
  // when names, rooms and domains are otherwise identical.
  favoriteConfigGroups=deduplicateControlGroups(rows).sort(function(a,b){
    return String(a.row.room||'').localeCompare(String(b.row.room||''))||
      displayDeviceName(a.row).localeCompare(displayDeviceName(b.row))||
      String(a.row.id||'').localeCompare(String(b.row.id||''));
  });
  favoriteConfigRows=favoriteConfigGroups.map(function(group){return group.row;});
  var items=[
    {type:'heading',defaultValue:'Watch devices'},
    {type:'text',defaultValue:'Tap the star to favorite or the crossed circle to hide. Hidden favorites remain saved.'},
    {type:'toggle',messageKey:'REFRESH_DEVICES',label:'Force recheck now (Bridge)',
      defaultValue:false},
    // Keep the actual Clay checkbox inputs. Only restyle their two visible
    // controls into the right-aligned icon buttons used by Google Home.
    // This preserves keyboard/accessibility semantics and the existing
    // DEV_i[2] saved values (Favorite first, Hide second).
    {type:'text',defaultValue:
      '<style>'+
      '.component-checkbox{display:flex!important;align-items:center;gap:6px;min-height:46px;padding-top:4px!important;padding-bottom:4px!important;}'+
      // More-specific important rules must override the compact row's
      // display:flex!important, which defeated inline style.display='none'.
      '.component-checkbox>.label{display:block;flex:1 1 auto;min-width:0;font-weight:400!important;font-size:14px!important;line-height:1.25;white-space:normal;overflow-wrap:anywhere;padding:0!important;margin:0!important;max-height:2.6em;overflow:hidden;}'+
      '.component-checkbox .checkbox-group{display:flex;align-items:center;justify-content:flex-end;flex:0 0 auto;gap:0;margin:0!important;padding:0!important;}'+
      '.component-checkbox .checkbox-group label{display:flex!important;flex:0 0 44px;align-items:center;justify-content:center;width:44px;height:44px;min-width:44px;margin:0!important;padding:0!important;position:relative;}'+
      '.component-checkbox .checkbox-group label .label{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;}'+
      '.component-checkbox .checkbox-group i{display:block;position:relative;width:29px!important;height:29px!important;min-width:29px;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;flex-shrink:0;}'+
      '.component-checkbox .checkbox-group input:checked+i{border:0!important;background:transparent!important;}'+
      '.component-checkbox .checkbox-group i:after{display:none!important;}'+
      '.component-checkbox .checkbox-group label:first-child i:before{content:"☆";display:block;position:absolute;inset:0;font-size:29px;line-height:29px;text-align:center;font-family:Arial,sans-serif;color:#ff7a16;}'+
      '.component-checkbox .checkbox-group label:first-child input:checked+i:before{content:"★";}'+
      '.component-checkbox .checkbox-group label:nth-child(2) i{color:#929292;}'+
      '.component-checkbox .checkbox-group label:nth-child(2) input:checked+i{color:#ff7a16;}'+
      '.component-checkbox .checkbox-group label:nth-child(2) i:before{content:"";display:block;position:absolute;top:4px;left:4px;width:20px;height:20px;box-sizing:border-box;border:2px solid currentColor;border-radius:50%;}'+
      '.component-checkbox .checkbox-group label:nth-child(2) i:after{content:"";display:block!important;position:absolute;top:14px;left:2px;width:25px;height:2px;box-sizing:border-box;border:0!important;background:currentColor;transform:rotate(-45deg)!important;}'+
      '</style>'}
  ];
  var previousRoom='';
  favoriteConfigRows.forEach(function(r,i){
    var room=String(r.room||'Unassigned');
    if(room!==previousRoom){
      previousRoom=room;
      items.push({type:'heading',defaultValue:room.slice(0,36)});
    }
    // Native Clay checkbox groups are serialized by the phone configuration
    // page. They do not use Pebble AppMessage keys or a finite 48-item list.
    items.push({
      type:'checkboxgroup',
      messageKey:'DEV_'+i,
      label:escapeSettingsText(displayDeviceName(r).slice(0,65)),
      defaultValue:[favorites.indexOf(r.id)>=0,hidden.indexOf(r.id)>=0],
      options:['Favorite','Hide']
    });
  });
  if(!favoriteConfigRows.length)
    items.push({type:'text',defaultValue:'No cached devices yet. Open Devices by Room on the watch, then reopen Settings.'});
  // Display and Bridge first, then the grouped per-device controls.
  cfg.splice(cfg.length-1,0,{type:'section',items:items});
  // No client-side device type filter: every discovered device is listed,
  // grouped by room, and can be favorited/hidden independently.
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
  var message={COMMAND:'SETTINGS',FONT_SIZE:fontChoice==='large'?28:24,
    THEME_MODE_CODE:themeMode==='night'?1:themeMode==='day'?0:2,
    LARGE_TEXT:fontChoice==='large'?1:0,
    AUTO_SEND:autoSend?1:0,HAPTIC_LEVEL:hapticValues[hapticLevel]||0};
  Pebble.sendAppMessage(message,
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
      var group=favoriteConfigGroups[i]||{ids:[r.id]};
      var newFavorite=valueBoolean(selections[0],false);
      var newHidden=valueBoolean(selections[1],false);
      group.ids.forEach(function(id){
        var oldFavorite=chosen.indexOf(id)>=0;
        var oldHidden=hidden.indexOf(id)>=0;
        if(newFavorite!==oldFavorite||newHidden!==oldHidden)visibilityChanged=true;
        chosen=chosen.filter(function(saved){return saved!==id;});
        hidden=hidden.filter(function(saved){return saved!==id;});
        if(newFavorite)chosen.push(id);
        if(newHidden)hidden.push(id);
      });
    });
    localStorage.setItem('HA_FAVORITES_V1',JSON.stringify(chosen));
    localStorage.setItem('HA_HIDDEN_V1',JSON.stringify(hidden));
    if(visibilityChanged){
      // One small invalidation instead of retransmitting every room/device.
      Pebble.sendAppMessage({COMMAND:'CTRL_INVALIDATE'},null,function(){});
    }
  }
  if(valueBoolean(field('REFRESH_DEVICES'),false)){
    forceRefreshControls().catch(function(err){
      console.log('Manual Bridge refresh: '+String(err&&err.message||err));
    });
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
  sendWatchSettings(false);
  updateWeatherSubscription();
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
var LAST_REV_KEY='HA_WATCH_PAGE_REV_V3';
var WATCH_IDS_KEY='HA_WATCH_PAGE_IDS_V3';
function normalizeCatalog(rows,mode){
  var favorites=favoriteIds(),hidden=hiddenIds();
  return deduplicateControls(rows).filter(function(r){
    if(!r||typeof r.id!=='string'||hidden.indexOf(r.id)>=0)return false;
    if(mode===1)return favorites.indexOf(r.id)>=0;
    if(mode===2)return isRunAction(r.domain);
    return true;
  }).sort(function(a,b){
    return String(a.room||'').localeCompare(String(b.room||''))||
      String(a.name||'').localeCompare(String(b.name||''))||
      String(a.id||'').localeCompare(String(b.id||''));
  }).map(function(r){
    return {id:r.id,name:displayDeviceName(r),room:r.room,domain:r.domain,
      favorite:favorites.indexOf(r.id)>=0};
  });
}
function catalogRevision(rows,mode,offset){
  // Only the identity/labels/room/favorite flags of THIS watch page.
  // Live state and advanced capabilities are never cached here.
  var raw='HA-WATCH-PAGE-V3|'+mode+'|'+offset+'|'+rows.map(function(r){
    return [r.id,r.name,r.room,r.domain,r.favorite?'1':'0'].join('|');
  }).join('\\n'),hash=5381;
  for(var i=0;i<raw.length;i++)hash=((hash*33)^raw.charCodeAt(i))|0;
  return hash||1;
}
function controlSend(message,next,attempt){
  attempt=attempt||0;
  Pebble.sendAppMessage(message,function(){if(next)next(true);},function(err){
    if(attempt<2)
      setTimeout(function(){controlSend(message,next,attempt+1);},220*(attempt+1));
    else{
      console.log('Control transport failed: '+JSON.stringify(err));
      if(next)next(false);
    }
  });
}
function controlRow(r,index){
  return {COMMAND:'CTRL_ROW',CTRL_INDEX:index,
    CTRL_NAME:String(r.name||'Device').slice(0,35),
    CTRL_ROOM:String(r.room||'Unassigned').slice(0,21),
    CTRL_KIND:controlKind(r.domain,r.name,r.id),CTRL_FAV:r.favorite?1:0};
}
var controlRows=[];
var statePageGeneration=0;
var currentPageRevision=0;
var STATE_FETCH_CONCURRENCY=6;
// Short-lived phone RAM cache. Never persisted to localStorage or the watch.
// The same six-slot scheduler is shared by startup prefetch and page views.
var STATE_PRELOAD_TTL_MS=60*1000;
var statePreload={},statePending={},stateJobs=[],stateActive=0;
var statePreloadEpoch=0;
function stateQueuePump(){
  while(stateActive<STATE_FETCH_CONCURRENCY&&stateJobs.length){
    var job=stateJobs.shift();
    stateActive++;
    (function(job){
      pluginAction('get_state',{entity_id:job.id}).then(function(result){
        var fresh=pluginJson(result);
        if(fresh&&fresh.state!==undefined){
          statePreload[job.id]={value:fresh,at:Date.now()};
        }
        job.resolve(fresh);
      }).catch(function(err){
        job.reject(err);
      }).then(function(){
        stateActive--;
        delete statePending[job.id];
        stateQueuePump();
      });
    })(job);
  }
}
function readStateOnPhone(id){
  var now=Date.now(),cached=statePreload[id];
  if(cached&&now-cached.at>=0&&now-cached.at<STATE_PRELOAD_TTL_MS)
    return Promise.resolve(cached.value);
  if(statePending[id])return statePending[id];
  statePending[id]=new Promise(function(resolve,reject){
    stateJobs.push({id:id,resolve:resolve,reject:reject});
  });
  stateQueuePump();
  return statePending[id];
}
function prefetchOnOpen(){
  var epoch=++statePreloadEpoch;
  return fetchControlsIfStale(false).then(function(rows){
    if(epoch!==statePreloadEpoch)return;
    // Favor favorites plus the first 32 room-sorted controls. The remaining
    // pages load on demand; opening the app never floods the entire home.
    var home=normalizeCatalog(rows,0);
    var favored=normalizeCatalog(rows,1);
    var selected={},queue=[];
    favored.concat(home.slice(0,PAGE_SIZE)).forEach(function(row){
      if(isRunAction(row.domain)||selected[row.id])return;
      selected[row.id]=true;queue.push(row);
    });
    // No Pebble.sendAppMessage from prefetch: Bluetooth stays idle until
    // the user actually opens Favorites or Devices by Room.
    return Promise.all(queue.map(function(r){
      return readStateOnPhone(r.id).catch(function(err){
        console.log('State prefetch '+r.id+': '+String(err&&err.message||err));
      });
    }));
  }).catch(function(err){
    console.log('Startup prefetch unavailable: '+String(err&&err.message||err));
  });
}

function refreshPageStates(page,revision,generation){
  // Load current-page statuses in parallel; metadata and type icons are
  // already visible. BLE AppMessages are still sent ONE at a time, waiting
  // for each ACK to avoid overflowing the Pebble phone/watch queues.
  // Nothing is persisted, and a new page invalidates old in-flight results.
  var cursor=0,sendQueue=[],sending=false;
  function drain(){
    if(sending||generation!==statePageGeneration||!sendQueue.length)return;
    sending=true;
    var message=sendQueue.shift();
    controlSend(message,function(){
      sending=false;
      if(generation===statePageGeneration)drain();
    });
  }
  function worker(){
    if(generation!==statePageGeneration)return Promise.resolve();
    var index=cursor++;
    if(index>=page.length)return Promise.resolve();
    var row=page[index];
    if(isRunAction(row.domain))return worker();
    return readStateOnPhone(row.id).then(function(fresh){
      if(generation!==statePageGeneration)return;
      if(fresh&&fresh.state!==undefined){
        sendQueue.push({COMMAND:'CTRL_STATE',CTRL_INDEX:index,
          CTRL_REV:revision,CTRL_STATUS:String(fresh.state).slice(0,11),
          CTRL_SUBTITLE:deviceStatusSubtitle(row,fresh)});
        drain();
      }
    }).catch(function(err){
      console.log('Background device state '+index+': '+String(err&&err.message||err));
    }).then(worker);
  }
  var workers=[];
  for(var i=0;i<Math.min(STATE_FETCH_CONCURRENCY,page.length);i++)
    workers.push(worker());
  return Promise.all(workers);
}
function sendCatalog(watchRevision,rows,mode,offset,alwaysSend){
  mode=mode===1||mode===2?mode:0;
  var full=normalizeCatalog(rows,mode),total=full.length;
  offset=Math.max(0,Math.floor(Number(offset)||0));
  if(total&&offset>=total)offset=Math.floor((total-1)/PAGE_SIZE)*PAGE_SIZE;
  if(!total)offset=0;
  controlRows=full.slice(offset,offset+PAGE_SIZE);
  currentWatchMode=mode;currentWatchOffset=offset;
  var generation=++statePageGeneration;
  var pageSnapshot=controlRows.slice();
  var revision=catalogRevision(pageSnapshot,mode,offset);
  currentPageRevision=revision;
  var lastSentRev=Number(localStorage.getItem(LAST_REV_KEY)||0);
  var transmit=!!alwaysSend||watchRevision!==revision||lastSentRev!==revision;
  var packets=transmit?pageSnapshot.map(controlRow):[];
  function sendAt(i){
    if(i===packets.length){
      controlSend({COMMAND:'CTRL_DONE',CTRL_TOTAL:controlRows.length,
        CTRL_GRAND_TOTAL:total,CTRL_HAS_MORE:offset+controlRows.length<total?1:0,
        CTRL_OFFSET:offset,CTRL_REV:revision},function(ok){
          if(ok&&generation===statePageGeneration){
            localStorage.setItem(LAST_REV_KEY,String(revision));
            localStorage.setItem(WATCH_IDS_KEY,JSON.stringify(pageSnapshot.map(function(r){return r.id;})));
            refreshPageStates(pageSnapshot,revision,generation);
          }
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
var forceRefreshPromise=null;
function forceRefreshControls(){
  if(forceRefreshPromise)return forceRefreshPromise;
  localStorage.removeItem(CATALOG_FETCH_AT_KEY);
  forceRefreshPromise=fetchControlsIfStale(true).then(function(rows){
    sendCatalog(0,rows,currentWatchMode,currentWatchOffset,true);
    return rows;
  }).catch(function(err){
    console.log('Forced discovery: '+String(err&&err.message||err));
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:'Refresh failed'});
    throw err;
  }).then(function(value){forceRefreshPromise=null;return value;},
    function(err){forceRefreshPromise=null;throw err;});
  return forceRefreshPromise;
}
function controlLoad(watchRevision,mode,offset){
  fetchControlsIfStale(false).then(function(rows){
    sendCatalog(Number(watchRevision)||0,rows,mode,offset,false);
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}

function controlAt(index){
  // Resolve against the acknowledged index mapping, not a stale array.
  var ids=[];
  try{ids=JSON.parse(localStorage.getItem(WATCH_IDS_KEY)||'[]');}catch(e){}
  var id=ids[index]||(controlRows[index]&&controlRows[index].id);
  if(!id){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:'Reload devices'});
    controlSend({COMMAND:'CTRL_INVALIDATE'});
    return null;
  }
  var r=getCachedControls().filter(function(x){return x.id===id;})[0]||
    controlRows.filter(function(x){return x.id===id;})[0];
  return r?{id:id,row:r}:null;
}
function detailMeta(fresh,domain){
  var a=fresh&&fresh.attributes||{},level=-1,adjustable=false;
  if(domain==='light'){
    var modes=Array.isArray(a.supported_color_modes)?a.supported_color_modes:[];
    adjustable=modes.some(function(m){return m!=='onoff';})||
      typeof a.brightness==='number';
    if(typeof a.brightness==='number')
      level=Math.max(0,Math.min(100,Math.round(a.brightness*100/255)));
    else if(String(fresh.state)==='off'&&adjustable)level=0;
  }else if(domain==='fan'){
    adjustable=typeof a.percentage==='number'||((Number(a.supported_features)||0)&1)!==0;
    if(typeof a.percentage==='number')
      level=Math.max(0,Math.min(100,Math.round(a.percentage)));
    else if(String(fresh.state)==='off'&&adjustable)level=0;
  }
  return {level:level,adjustable:adjustable};
}
function syncFreshState(index,r,fresh,complete){
  if(!fresh||fresh.state===undefined)throw Error('Missing current state');
  // State and adjustable capability live only in memory for this selected
  // device. Never put them in the phone catalog or watch persistent storage.
  var state=String(fresh.state),meta=detailMeta(fresh,r.domain);
  var subtitle=deviceStatusSubtitle(r,fresh);
  controlSend({COMMAND:'CTRL_STATE',CTRL_INDEX:index,CTRL_REV:currentPageRevision,
    CTRL_STATUS:state.slice(0,11),CTRL_SUBTITLE:subtitle},function(ok){
    if(!ok)return;
    controlSend({COMMAND:'CTRL_DETAIL_STATE',CTRL_INDEX:index,
      CTRL_STATUS:state.slice(0,11),CTRL_SUBTITLE:subtitle,CTRL_LEVEL:meta.level,
      CTRL_ADJUSTABLE:meta.adjustable?1:0},function(ok2){
      if(ok2&&complete)controlSend({COMMAND:'CTRL_ACTION_DONE',CTRL_STATUS:'Updated'});
    });
  });
}
function controlInspect(index){
  var item=controlAt(index);
  if(!item)return;
  if(isRunAction(item.row.domain)){controlAct(index);return;}
  // One get_state only on interaction, not N lookups per device/room page.
  pluginAction('get_state',{entity_id:item.id}).then(function(result){
    var fresh=pluginJson(result),meta=detailMeta(fresh,item.row.domain);
    if(meta.adjustable||item.row.domain==='lock'||item.row.domain==='cover'){
      controlSend({COMMAND:'CTRL_DETAIL_OPEN',CTRL_INDEX:index},function(ok){
        if(ok)syncFreshState(index,item.row,fresh,false);
      });
    }else{
      controlAct(index);
    }
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}
function controlDetails(index){
  var item=controlAt(index);
  if(!item)return;
  pluginAction('get_state',{entity_id:item.id}).then(function(result){
    syncFreshState(index,item.row,pluginJson(result),false);
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}
function controlAdjust(index,direction){
  var item=controlAt(index);
  if(!item||!(direction===1||direction===-1))return;
  var domain=item.id.split('.')[0];
  if(domain!=='light'&&domain!=='fan')return;
  pluginAction('get_state',{entity_id:item.id}).then(function(result){
    var fresh=pluginJson(result),meta=detailMeta(fresh,domain);
    if(!meta.adjustable)throw Error('Level control unavailable');
    var base=meta.level>=0?meta.level:(fresh.state==='off'?0:100);
    var a=fresh.attributes||{};
    var step=domain==='fan'?Number(a.percentage_step)||10:10;
    if(!isFinite(step)||step<=0||step>100)step=10;
    var next=Math.max(0,Math.min(100,Math.round(base+direction*step)));
    if(next===base){syncFreshState(index,item.row,fresh,false);return null;}
    var service=next===0?'turn_off':domain==='fan'?'set_percentage':'turn_on';
    var data={entity_id:item.id};
    if(next>0){
      if(domain==='fan')data.percentage=next;
      else data.brightness_pct=next;
    }
    return pluginAction('call_service',{domain:domain,service:service,data:data});
  }).then(function(result){
    if(!result)return;
    pluginJson(result);
    return pluginAction('get_state',{entity_id:item.id});
  }).then(function(result){
    if(result)syncFreshState(index,item.row,pluginJson(result),true);
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}
// Touch slider commits only when SELECT is pressed; unlike button stepping,
 // the phone receives the exact user-selected percentage.
function controlSetLevel(index,requested){
  var item=controlAt(index);
  if(!item)return;
  var domain=item.id.split('.')[0];
  if(domain!=='light'&&domain!=='fan')return;
  var level=Math.round(Number(requested));
  if(!isFinite(level)||level<0||level>100)return;
  pluginAction('get_state',{entity_id:item.id}).then(function(result){
    var fresh=pluginJson(result);
    if(!detailMeta(fresh,domain).adjustable)throw Error('Level control unavailable');
    var service=level===0?'turn_off':domain==='fan'?'set_percentage':'turn_on';
    var data={entity_id:item.id};
    if(level>0){
      if(domain==='fan')data.percentage=level;
      else data.brightness_pct=level;
    }
    return pluginAction('call_service',{domain:domain,service:service,data:data});
  }).then(function(result){
    pluginJson(result);
    return pluginAction('get_state',{entity_id:item.id});
  }).then(function(result){
    syncFreshState(index,item.row,pluginJson(result),true);
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}
function controlSecureAct(index){
  var item=controlAt(index);
  if(!item||!/^(lock|cover)$/.test(item.row.domain))return;
  pluginAction('secure_control',{entity_id:item.id}).then(function(result){
    pluginJson(result);
    return pluginAction('get_state',{entity_id:item.id});
  }).then(function(result){
    // The command may take a few seconds to move a garage door. Report
    // the observed state, not a promise that it is already fully open.
    syncFreshState(index,item.row,pluginJson(result),true);
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}
function controlAct(index){
  var item=controlAt(index);
  if(!item)return;
  pluginAction('control_entity',{entity_id:item.id}).then(function(result){
    pluginJson(result);
    if(isRunAction(item.row.domain)){
      controlSend({COMMAND:'CTRL_ACTION_DONE',CTRL_STATUS:'Triggered'});
      return null;
    }
    return pluginAction('get_state',{entity_id:item.id});
  }).then(function(result){
    if(result)syncFreshState(index,item.row,pluginJson(result),true);
  }).catch(function(err){
    controlSend({COMMAND:'CTRL_ERROR',CTRL_STATUS:String(err.message||err).slice(0,26)});
  });
}

Pebble.addEventListener('appmessage',function(event){
  var d=event.payload||{};
  if(audio.handleMessage(d))return;
  if(d.COMMAND==='CTRL_PREFETCH'){
    prefetchOnOpen();return;
  }
  if(d.COMMAND==='CTRL_REQUEST'){
    controlLoad(Number(d.CTRL_REV)||0,Number(d.CTRL_INDEX)||0,Number(d.CTRL_OFFSET)||0);
    return;
  }
  if(d.COMMAND==='CTRL_INSPECT'){controlInspect(Number(d.CTRL_INDEX));return;}
  if(d.COMMAND==='CTRL_FORCE_REFRESH'){
    forceRefreshControls().catch(function(){});return;
  }
  if(d.COMMAND==='CTRL_THEME_SET'){
    var m=Number(d.CTRL_INDEX);
    if(m>=0&&m<=2){
      themeMode=m===0?'day':m===1?'night':'auto';
      localStorage.setItem('HA_THEME_MODE',themeMode);
      updateWeatherSubscription();
      sendWatchSettings(false);
    }
    return;
  }
  if(d.COMMAND==='CTRL_FONT_SET'){
    fontChoice=Number(d.CTRL_INDEX)===1?'large':'normal';
    localStorage.setItem('FONT_CHOICE',fontChoice);
    localStorage.setItem('FONT_SIZE',String(fontChoice==='large'?28:24));
    sendWatchSettings(false);return;
  }
  if(d.COMMAND==='CTRL_SECURE_ACT'){controlSecureAct(Number(d.CTRL_INDEX));return;}
  if(d.COMMAND==='CTRL_ACT'){controlAct(Number(d.CTRL_INDEX));return;}
  if(d.COMMAND==='CTRL_DETAILS'){controlDetails(Number(d.CTRL_INDEX));return;}
  if(d.COMMAND==='CTRL_ADJUST'){controlAdjust(Number(d.CTRL_INDEX),Number(d.CTRL_DIRECTION));return;}
  if(d.COMMAND==='CTRL_SET_LEVEL'){controlSetLevel(Number(d.CTRL_INDEX),Number(d.CTRL_LEVEL));return;}
  if(d.COMMAND!=='DICTATION'&&d.COMMAND!=='CONV_DICTATION')return;
  var legacy=d.COMMAND==='CONV_DICTATION';
  if(!d.TEXT){replyError('No dictation captured',legacy);return;}
  askViaBridge(d.TEXT,legacy,d.VOLUME===0);
});
