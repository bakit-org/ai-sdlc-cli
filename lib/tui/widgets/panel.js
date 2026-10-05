'use strict';
// Bordered box with an optional title in the top edge. Used by the input box,
// the review screen and the result panels.
const { truncate, padEnd, visibleWidth } = require('../text-width');

const MAX_BOX = 100;

// tone: '' = gradient border, otherwise a theme role such as 'ok' or 'warn'.
function renderBox({ theme, width, rows, title = '', tone = '' }) {
  const w = Math.max(12, Math.min(width, MAX_BOX));
  const inner = w - 4;
  const b = theme.box;
  const fill = w - 2;
  const edge = (text, from, to) => (tone ? theme.paint(tone, text) : theme.gradient(text, from, to));
  let top;
  if (title) {
    const label = ` ${truncate(title, fill - 4)} `;
    top = `${b.tl}${b.h}${label}${b.h.repeat(Math.max(0, fill - 1 - visibleWidth(label)))}${b.tr}`;
  } else top = `${b.tl}${b.h.repeat(fill)}${b.tr}`;
  const left = edge(b.v, 0, 0);
  const right = edge(b.v, 1, 1);
  return [
    edge(top, 0, 1),
    ...rows.map((row) => `${left} ${padEnd(truncate(row, inner, theme.sym.ellipsis), inner)} ${right}`),
    edge(`${b.bl}${b.h.repeat(fill)}${b.br}`, 0, 1),
  ];
}

const renderPanel = ({ theme, width, title, lines, tone }) => renderBox({ theme, width, rows: lines, title, tone });

module.exports = { renderBox, renderPanel, MAX_BOX };
