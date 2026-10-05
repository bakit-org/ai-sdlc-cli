'use strict';
// Drives a widget screen with scripted key bytes, without a terminal.
const { createKeyParser } = require('../lib/tui/keys');
const { createTheme } = require('../lib/tui/theme');
const { stripAnsi } = require('../lib/tui/text-width');

const plainTheme = createTheme({ level: 0, unicode: true, attrs: false });
const ctx = (theme = plainTheme, extra = {}) => ({ theme, width: 80, rows: 30, columns: 81, ...extra });

function keysOf(bytes) {
  const out = [];
  createKeyParser((k) => out.push(k), { escapeMs: 0 }).feed(bytes);
  return out;
}

// Feeds scripted keys to a screen without a terminal.
function drive(screen, bytes, c = ctx()) {
  let state = screen.init;
  let done;
  for (const k of keysOf(bytes)) {
    const out = screen.onKey(state, k, c);
    if (out.done !== undefined) {
      done = out.done;
      break;
    }
    if (out.state) state = out.state;
  }
  return { state, done, text: screen.view(state, c).map(stripAnsi).join('\n') };
}

module.exports = { plainTheme, ctx, keysOf, drive };
