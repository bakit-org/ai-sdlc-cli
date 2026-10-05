'use strict';
// Width helpers for strings that may carry ANSI sequences: display width,
// truncation that never cuts inside an escape sequence or a character cluster.

// CSI (colours, cursor), OSC (titles, links; BEL or ST terminated), and two-character escapes.
const ESC_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const RESET = '\x1b[0m';

// East Asian wide / fullwidth and emoji blocks: two terminal cells each.
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
  // Emoji_Presentation characters among the symbol blocks (the check mark, warning and
  // pointer glyphs used by the UI are text-presentation and stay one cell wide).
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
];

const stripAnsi = (s) => String(s).replace(ESC_SEQ, '');

function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // combining marks, zero-width space/joiners, variation selectors
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3) return 0;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const SIMPLE = /^[\x20-\x7e]*$/;

// Characters a user sees as one: letter plus combining marks, emoji with skin tone or joiners, flags.
function graphemes(text) {
  const str = String(text);
  if (SIMPLE.test(str)) return str.split('');
  return segmenter ? Array.from(segmenter.segment(str), (s) => s.segment) : Array.from(str);
}

// Cells a cluster occupies: the widest member, and emoji sequences / flags are always two.
function clusterWidth(cluster) {
  const cps = Array.from(cluster, (c) => c.codePointAt(0));
  if (cps.length === 1) return charWidth(cps[0]);
  if (cps.includes(0xfe0f) || cps.includes(0x200d)) return 2;
  if (cps.length === 2 && cps.every((c) => c >= 0x1f1e6 && c <= 0x1f1ff)) return 2;
  return Math.max(...cps.map(charWidth));
}

// Splits into { esc: true, s } sequences and { s, w } clusters.
function* parts(str) {
  let last = 0;
  const text = (chunk) => graphemes(chunk).map((g) => ({ s: g, w: clusterWidth(g) }));
  for (const m of str.matchAll(ESC_SEQ)) {
    if (m.index > last) yield* text(str.slice(last, m.index));
    yield { esc: true, s: m[0], w: 0 };
    last = m.index + m[0].length;
  }
  if (last < str.length) yield* text(str.slice(last));
}

function visibleWidth(s) {
  const str = String(s);
  if (SIMPLE.test(str)) return str.length;
  let w = 0;
  for (const p of parts(str)) w += p.w;
  return w;
}

// Cuts to `max` cells (ellipsis included), keeping escape sequences whole and
// closing any open styling.
function truncate(s, max, ellipsis = '…') {
  const str = String(s);
  if (visibleWidth(str) <= max) return str;
  const ew = visibleWidth(ellipsis);
  if (max <= ew) return max > 0 ? ellipsis.slice(0, max) : '';
  const budget = max - ew;
  let out = '';
  let used = 0;
  let styled = false;
  for (const p of parts(str)) {
    if (p.esc) {
      out += p.s;
      styled = true;
    } else if (used + p.w > budget) break;
    else {
      out += p.s;
      used += p.w;
    }
  }
  return `${out}${styled ? RESET : ''}${ellipsis}`;
}

// For plain strings such as paths: keeps the start and the end, drops the middle.
function truncateMiddle(s, max, ellipsis = '…') {
  const str = String(s);
  if (visibleWidth(str) <= max) return str;
  const ew = visibleWidth(ellipsis);
  if (max <= ew) return max > 0 ? ellipsis.slice(0, max) : '';
  const budget = max - ew;
  const take = (list, room) => {
    const out = [];
    let used = 0;
    for (const g of list) {
      const w = clusterWidth(g);
      if (used + w > room) break;
      out.push(g);
      used += w;
    }
    return out;
  };
  const all = graphemes(str);
  const tailRoom = Math.ceil(budget * 0.65);
  return `${take(all, budget - tailRoom).join('')}${ellipsis}${take([...all].reverse(), tailRoom).reverse().join('')}`;
}

const padEnd = (s, width) => `${s}${' '.repeat(Math.max(0, width - visibleWidth(s)))}`;

module.exports = { stripAnsi, visibleWidth, truncate, truncateMiddle, padEnd, charWidth, clusterWidth, graphemes, ESC_SEQ, RESET };
