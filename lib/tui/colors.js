'use strict';
// Terminal colour capability + helpers. Honors NO_COLOR and non-TTY output.

// 0 = none, 1 = basic 16 colours, 3 = truecolor
function colorLevel(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (env.FORCE_COLOR === '0') return 0;
  if (!stream.isTTY && !env.FORCE_COLOR) return 0;
  if (env.TERM === 'dumb') return 0;
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit' || env.TERM_PROGRAM === 'iTerm.app' || env.WT_SESSION) return 3;
  return 1;
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Colour at position t (0..1) along a list of [r,g,b] stops.
function gradientAt(stops, t) {
  if (stops.length === 1) return stops[0];
  const scaled = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(scaled), stops.length - 2);
  const f = scaled - i;
  return stops[i].map((c, k) => lerp(c, stops[i + 1][k], f));
}

// Darken a colour toward a backdrop (used for drop shadows).
const shade = (rgb, amount = 0.3, backdrop = [36, 36, 56]) => rgb.map((c, k) => lerp(backdrop[k], c, amount));

const fg = (rgb) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const bg = (rgb) => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const RESET = '\x1b[0m';

module.exports = { colorLevel, gradientAt, shade, fg, bg, RESET };
