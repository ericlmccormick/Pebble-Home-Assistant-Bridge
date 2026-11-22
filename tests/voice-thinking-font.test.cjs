'use strict';
const fs=require('fs'),assert=require('assert');
const c=fs.readFileSync('src/c/main.c','utf8');
const pkg=require('../package.json');
assert.match(pkg.version,/^[0-9]+[.][0-9]+[.][0-9]+$/);
assert.strictEqual(pkg.pebble.displayName,'Home Assistant Control Center');
assert(c.includes('static void update_thinking_transcript_font(void)'), 'Shared transcript layout helper');
assert(c.includes('s_large_text ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD'), 'Match large/normal menu title fonts');
assert(c.includes('const int height = s_large_text ? 106 : 74'), 'Enlarge transcript bounds for large text');
const settings=c.slice(c.indexOf('strcmp(command_tuple->value->cstring, "SETTINGS")'),c.indexOf('strcmp(command_tuple->value->cstring, "HAPTIC_PREVIEW")'));
const applyTheme=c.slice(c.indexOf('static void apply_theme_and_font(void)'),c.indexOf('void app_set_theme_mode(int mode)'));
assert(settings.includes('apply_theme_and_font();') && applyTheme.includes('update_thinking_transcript_font();'),
  'Apply new font immediately when settings change');
const start=c.indexOf('s_thinking_transcript_layer = text_layer_create');
const initial=c.slice(start,c.indexOf('layer_set_hidden(text_layer_get_layer(s_thinking_transcript_layer), true)',start));
assert(initial.includes('update_thinking_transcript_font();'), 'Restore persisted normal/large choice at initial load');
console.log('Normal/large voice-thinking transcript sizing passed');
