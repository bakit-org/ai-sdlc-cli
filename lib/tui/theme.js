'use strict';
// Palette and symbols. One object answers every "how do I draw this" question:
// colour level (0 none, 1 sixteen colours, 3 truecolor), whether text attributes
// (dim, bold, inverse) are safe, and unicode versus ASCII symbols.
const { colorLevel, gradientAt, fg, RESET } = require('./colors');

const STOPS = [[71, 150, 228], [132, 122, 206], [195, 103, 127]];
// role -> [truecolor rgb | null, sixteen-colour code | null, attribute code | null]
const ROLES = {
  accent: [[71, 150, 228], '94'],
  purple: [[132, 122, 206], '95'],
  pink: [[195, 103, 127], '91'],
  ok: [[90, 200, 130], '32'],
  warn: [[230, 180, 80], '33'],
  err: [[230, 95, 95], '31'],
  dim: [null, null, '2'],
  bold: [null, null, '1'],
};

const UNICODE = {
  ok: '✔', warn: '⚠', err: '✖', info: '•', dot: '·', pointer: '❯', bullet: '•', ellipsis: '…', arrow: '→',
  up: '↑', down: '↓', bar: ['█', '░'], spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
};
const ASCII = {
  ok: '+', warn: '!', err: 'x', info: '-', dot: '|', pointer: '>', bullet: '*', ellipsis: '...', arrow: '->',
  up: '^', down: 'v', bar: ['#', '-'], spinner: ['|', '/', '-', '\\'],
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
};

// Box-drawing and block glyphs need a UTF-8 locale; TERM=linux/dumb never get them.
function detectUnicode(env, platform = process.platform) {
  if (env.TERM === 'linux' || env.TERM === 'dumb') return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (locale) return /utf-?8/i.test(locale);
  if (platform === 'win32') return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI);
  return true;
}

function createTheme({ env = process.env, stream = process.stdout, level, unicode, attrs, platform } = {}) {
  const lvl = level !== undefined ? level : colorLevel(env, stream);
  const uni = unicode !== undefined ? unicode : detectUnicode(env, platform);
  const hasAttrs = attrs !== undefined ? attrs : lvl > 0 || (Boolean(stream && stream.isTTY) && env.TERM !== 'dumb');

  const open = (role) => {
    const def = ROLES[role];
    if (!def) return '';
    if (def[2]) return hasAttrs ? `\x1b[${def[2]}m` : '';
    if (lvl === 3) return fg(def[0]);
    return lvl === 1 ? `\x1b[${def[1]}m` : '';
  };

  // paint('ok bold', 'text'): roles joined, closed with a full reset.
  const paint = (roles, text) => {
    const prefix = String(roles).split(' ').map(open).join('');
    return prefix ? `${prefix}${text}${RESET}` : String(text);
  };

  // Blue to purple to pink across the visible characters of `text`.
  const gradient = (text, from = 0, to = 1) => {
    if (lvl === 0) return String(text);
    const chars = [...String(text)];
    return chars.map((ch, i) => {
      if (ch === ' ') return ch;
      const t = chars.length < 2 ? from : from + ((to - from) * i) / (chars.length - 1);
      return lvl === 3 ? `${fg(gradientAt(STOPS, t))}${ch}${RESET}` : paint(t < 0.34 ? 'accent' : t < 0.67 ? 'purple' : 'pink', ch);
    }).join('');
  };

  return {
    level: lvl,
    unicode: uni,
    attrs: hasAttrs,
    sym: uni ? UNICODE : ASCII,
    box: (uni ? UNICODE : ASCII).box,
    paint,
    gradient,
    // Text caret: inverse video where attributes work, nothing extra otherwise.
    caret: (ch) => (hasAttrs ? `\x1b[7m${ch || ' '}\x1b[27m` : ch || ' '),
    tone: (status) => ({ ok: 'ok', warn: 'warn', fail: 'err', err: 'err', info: 'dim' }[status] || ''),
  };
}

module.exports = { createTheme, detectUnicode };
