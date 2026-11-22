'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = fs.readFileSync('src/c/main.c', 'utf8');
const shared = fs.readFileSync('src/c/solar_theme.h', 'utf8');
const init = C.slice(C.indexOf('static void init() {'), C.indexOf('static void deinit() {'));
const firstFrame = init.indexOf('window_stack_push(s_main_window, true)');
for (const step of ['solar_theme_load()', 'persist_read_int(PERSIST_KEY_THEME_MODE)',
  's_theme_dark = solar_theme_dark(s_theme_mode)', 'controls_apply_settings(s_large_text,s_theme_dark)']) {
  assert(init.includes(step) && init.indexOf(step) < firstFrame, step);
}
assert(init.includes('tick_timer_service_subscribe(MINUTE_UNIT, appearance_tick)'));
assert(shared.includes('persist_read_data(SOLAR_THEME_STORAGE_KEY'));
assert(shared.includes('persist_write_data(SOLAR_THEME_STORAGE_KEY'));
assert(C.includes('solar_theme_receive(iterator)'));
console.log('Control Center restores solar cache and computes appearance before first draw');
