'use strict';
const fs = require('fs');
const assert = require('assert');
const controls = fs.readFileSync('src/c/ha_controls.c', 'utf8');
const voice = fs.readFileSync('src/c/main.c', 'utf8');

function luminance(hex) {
  const v = [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255)
    .map(c => c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
  return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2];
}
function contrast(a,b) {
  const [l1,l2]=[luminance(a),luminance(b)].sort((x,y)=>y-x);
  return (l1+0.05)/(l2+0.05);
}
// GColor RGB values are constrained to Pebble's native 64-color RGB222 palette.
// Check both themes and highlighted rows against WCAG 4.5:1 normal-text target.
const textPairs = {
  day:['#000000','#ffffff'],
  daySecondary:['#555555','#ffffff'],
  night:['#ffffff','#000000'],
  nightSecondary:['#aaaaaa','#000000'],
  selectedColor:['#ffffff','#0000ff'],
  selectedBWDay:['#ffffff','#000000'],
  selectedBWNight:['#000000','#ffffff'],
  coloredBadgeYellow:['#000000','#ffff00'],
  coloredBadgeCyan:['#000000','#00ffff'],
  coloredBadgeOrange:['#000000','#ff5500'],
  coloredBadgeCerulean:['#000000','#00aaff'],
  coloredBadgeGray:['#000000','#aaaaaa'],
  selectedBadge:['#000000','#ffffff']
};
Object.entries(textPairs).forEach(([key,pair])=>{
  const ratio = contrast(pair[0],pair[1]);
  assert(ratio >= 4.5, key+' must contrast >=4.5, got '+ratio);
});
assert(controls.includes('GColorBlue,s_night_theme?GColorWhite:GColorBlack'),
  'Use a dark blue selection and inverse B&W theme');
assert(controls.includes('PBL_IF_COLOR_ELSE(GColorWhite,s_night_theme?GColorBlack:GColorWhite)'),
  'The selected text must match the selection background');
assert(controls.includes('static GColor cell_fg(bool active)'));
assert(controls.includes('static GColor cell_sub(bool active)'));
assert(controls.includes('(unknown||dimmed)?ui_muted():badge_ink(false)'),
  'Offline icons are gray; ON icons retain their category colors');
assert(!controls.includes('active?GColorBlack:GColorWhite'),
  'Hard-coded menu text overrides theme contrast');
assert(!controls.includes('active?GColorBlack:PBL_IF_COLOR_ELSE(GColorLightGray,GColorWhite)'),
  'Hard-coded secondary text must not recur');
for (const color of ['GColorJaegerGreen','GColorBlueMoon','GColorPurple']) {
  assert(!controls.includes('return '+color+';'), 'Dark badge fill with black pictogram: '+color);
}
for (const m of ['s_home_menu','s_menu']) {
  assert(controls.includes('menu_layer_set_normal_colors('+m+',ui_bg(),ui_fg());'));
  assert(controls.includes('menu_layer_set_highlight_colors('+m+',ui_selected_bg(),ui_selected_fg());'));
}
assert(controls.includes('graphics_context_set_text_color(ctx,ui_muted());'),
  'Room section labels follow the day/night muted text palette');
assert(controls.includes('graphics_context_set_text_color(ctx,cell_sub(active));'),
  'Secondary lines must have themed foreground');
assert(voice.includes('text_layer_set_text_color(s_thinking_transcript_layer,s_theme_dark?GColorWhite:GColorBlack)'),
  'The voice transcript needs night foreground');
assert(voice.includes('graphics_context_set_stroke_color(ctx, s_theme_dark ? GColorWhite : GColorBlack);'),
  'The voice spinner must remain visible at night');
assert(voice.includes('bitmap_layer_set_background_color(s_logo_layer,GColorWhite);'),
  'A dark logo needs a light backing at night');
console.log('Theme contrast and palette contract passed across day/night, icons and selection');
