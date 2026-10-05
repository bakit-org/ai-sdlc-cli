'use strict';
// Confirmation screen: a titled body that can scroll, Enter/y to proceed,
// Esc/n to step back. Optional `d` toggles a detailed body.
const { BACK } = require('../terminal');
const { renderBox } = require('./panel');

// body(state, ctx) returns the lines to show; state.expanded tells whether details are on.
// guardMs: Enter / y arriving sooner than this after the screen first appeared are
// ignored, so keys typed before the user could read it cannot confirm.
function createConfirm({ title, body, confirmLabel = 'Install', detailsToggle = false, guardMs = 150 }) {
  const windowSize = (ctx) => Math.max(5, ctx.rows - 7);

  function view(state, ctx) {
    const { theme, width } = ctx;
    const all = body(state, ctx);
    const size = windowSize(ctx);
    const top = Math.max(0, Math.min(state.scroll, Math.max(0, all.length - size)));
    const rows = all.slice(top, top + size);
    if (top > 0) rows[0] = theme.paint('dim', `${theme.sym.up} ${top} more above`);
    const below = all.length - (top + size);
    if (below > 0) rows[rows.length - 1] = theme.paint('dim', `${theme.sym.down} ${below} more below`);
    const keys = [`Enter ${confirmLabel.toLowerCase()}`];
    if (detailsToggle) keys.push(`d ${state.expanded ? 'hide' : 'show'} full list`);
    if (all.length > size) keys.push(`${theme.sym.up}${theme.sym.down} scroll`);
    keys.push('Esc back');
    return [...renderBox({ theme, width, title, rows }), theme.paint('dim', `  ${keys.join(` ${theme.sym.dot} `)}`)];
  }

  function onKey(state, key, ctx) {
    const total = body(state, ctx).length;
    const size = windowSize(ctx);
    const scroll = (n) => ({ state: { ...state, scroll: Math.max(0, Math.min(n, Math.max(0, total - size))) } });
    const tooSoon = ctx.elapsed !== undefined && ctx.elapsed < guardMs;
    switch (key.name) {
      case 'enter': return tooSoon ? { state } : { done: true };
      case 'escape': return { done: BACK };
      case 'up': return scroll(state.scroll - 1);
      case 'down': return scroll(state.scroll + 1);
      case 'pageup': return scroll(state.scroll - size);
      case 'pagedown': return scroll(state.scroll + size);
      case 'home': return scroll(0);
      case 'end': return scroll(total);
      default: break;
    }
    if (key.name === 'char' && !key.meta) {
      if (key.text === 'y' || key.text === 'Y') return tooSoon ? { state } : { done: true };
      if (key.text === 'n' || key.text === 'N') return { done: BACK };
      if (detailsToggle && (key.text === 'd' || key.text === 'D')) return { state: { ...state, expanded: !state.expanded, scroll: 0 } };
    }
    return { state };
  }

  return { init: { expanded: false, scroll: 0 }, view, onKey };
}

module.exports = { createConfirm };
