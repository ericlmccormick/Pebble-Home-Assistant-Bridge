'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const C=fs.readFileSync('src/c/main.c','utf8');
const CTRL=fs.readFileSync('src/c/ha_controls.c','utf8');
const JS=fs.readFileSync('src/pkjs/index.js','utf8');
assert(C.includes('persist_read_int(PERSIST_KEY_THEME_DARK)'));
assert(C.includes('persist_write_int(PERSIST_KEY_THEME_DARK,s_theme_dark?1:0)'));
assert(C.includes('persist_read_int(PERSIST_KEY_THEME_MODE)'));
assert(C.includes('persist_read_int(PERSIST_KEY_LARGE_TEXT)'));
const init=C.slice(C.indexOf('static void init() {'),C.indexOf('static void deinit() {'));
assert(init.indexOf('persist_read_int(PERSIST_KEY_THEME_DARK)')>=0);
assert(init.indexOf('persist_read_int(PERSIST_KEY_THEME_DARK)')<init.indexOf('window_stack_push(s_main_window, true)'),
  'Theme must be restored before drawing first watch window');
assert(init.indexOf('controls_apply_settings(s_large_text,s_theme_dark)')<init.indexOf('controls_home_open()'),
  'Home menu uses restored theme before first draw');
assert(CTRL.includes('window_set_background_color(w,ui_bg())'),'Home menu draws from restored colors');
assert(JS.includes('Date.now()-72*3600*1000'),'Solar cache is valid for up to 72 hours');
const begin=JS.indexOf('function effectiveThemeDark()');
const end=JS.indexOf('function onWeatherEnvelope(',begin);
assert(begin>=0&&end>begin);
const func=JS.slice(begin,end);
function run(nowStr,ageHours,riseHour,setHour,mode){
  const now=new Date(nowStr).getTime();
  const oldDay=new Date(now-ageHours*3600*1000);
  const rise=new Date(oldDay.getTime());rise.setHours(riseHour,0,0,0);
  const sunset=new Date(oldDay.getTime());sunset.setHours(setHour,0,0,0);
  const FakeDate=class extends Date{
    constructor(...a){super(...(a.length?a:[now]));}
    static now(){return now;}
  };
  const ctx={Date:FakeDate,themeMode:mode||'auto',
    weatherSunrise:Math.floor(rise.getTime()/1000),
    weatherSunset:Math.floor(sunset.getTime()/1000),
    weatherUpdatedAt:now-ageHours*3600*1000,
    localStorage:{getItem:()=> 'false'}};
  vm.createContext(ctx);vm.runInContext(func,ctx);
  return vm.runInContext('effectiveThemeDark()',ctx);
}
assert.strictEqual(run('2026-11-20T22:00:00',48,7,17),true,
  'At night a 2-day-old solar cache resolves to Night');
assert.strictEqual(run('2026-11-20T12:00:00',48,7,17),false,
  'During day the same aged cache resolves to Day');
assert.strictEqual(run('2026-11-20T05:30:00',26,7,17),true,
  'Before sunrise uses Night despite yesterday timestamps');
assert.strictEqual(run('2026-11-20T10:00:00',48,7,17,'night'),true,
  'Manual Night overrides solar cache');
assert.strictEqual(run('2026-11-20T22:00:00',48,7,17,'day'),false,
  'Manual Day overrides solar cache');
console.log('First-frame theme persistence, multi-day solar rollover, Day/Night overrides passed');
