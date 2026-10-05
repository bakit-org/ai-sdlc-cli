'use strict';
// The header every interactive screen starts with: banner, then a dim status line.
const { bannerFor } = require('../logo');

const indent = (lines) => lines.map((l) => `  ${l}`);

function bannerLines(session) {
  const { theme } = session;
  return ['', ...indent(bannerFor(session.columns, theme.level, { unicode: theme.unicode })), ''];
}

module.exports = { bannerLines, indent };
