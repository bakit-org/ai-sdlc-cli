'use strict';
// One-line progress bar: [#####-----]  45%  current step
const { truncate } = require('../text-width');

function renderProgress({ theme, width, done, total, label = '' }) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 1;
  const barWidth = Math.max(10, Math.min(40, width - 24));
  const filled = Math.round(barWidth * ratio);
  const [full, empty] = theme.sym.bar;
  const bar = theme.paint('accent', full.repeat(filled)) + theme.paint('dim', empty.repeat(barWidth - filled));
  const pct = `${String(Math.round(ratio * 100)).padStart(3)}%`;
  const head = `  ${bar} ${pct}  `;
  const room = Math.max(0, width - barWidth - 9);
  return `${head}${truncate(label, room, theme.sym.ellipsis)}`;
}

module.exports = { renderProgress };
