'use strict';
// Filterable list under an input box. Items: { label, hint, badge, tone, value, sticky, hotkey }.
// Sticky items stay visible whatever the filter says (e.g. "Enter a path...").
const { BACK } = require('../terminal');
const { editText, renderInputBox, endOf } = require('./input-box');
const { sanitize } = require('../sanitize');
const { truncate, truncateMiddle, padEnd, visibleWidth } = require('../text-width');

function filterItems(items, query) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((it) => it.sticky || terms.every((t) => `${it.label} ${it.hint || ''}`.toLowerCase().includes(t)));
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function createSelectList({ title, items, placeholder = 'Type to filter', maxVisible = 8, filterable = true, notice = '', footer = '' }) {
  const visibleFor = (state) => filterItems(items, state.value);

  // Keeps the cursor inside the window and the window inside the list.
  const settle = (state, count) => {
    const index = clamp(state.index, 0, Math.max(0, count - 1));
    let top = clamp(state.top, 0, Math.max(0, count - maxVisible));
    if (index < top) top = index;
    if (index >= top + maxVisible) top = index - maxVisible + 1;
    return { ...state, index, top };
  };

  function view(state, ctx) {
    const { theme, width } = ctx;
    const list = visibleFor(state);
    const s = settle(state, list.length);
    const lines = [theme.paint('bold', `  ${sanitize(title)}`)];
    if (notice) lines.push(`  ${theme.paint('warn', `${theme.sym.warn} ${sanitize(notice)}`)}`);
    if (filterable) lines.push(...renderInputBox({ theme, width, state, placeholder }));
    else lines.push('');
    const shown = list.slice(s.top, s.top + maxVisible).map((it) => ({ ...it, label: sanitize(it.label), hint: sanitize(it.hint || ''), badge: sanitize(it.badge || '') }));
    const labelW = Math.min(30, Math.max(0, ...shown.map((it) => visibleWidth(it.label))));
    const badgeW = Math.max(0, ...shown.map((it) => visibleWidth(it.badge || '')));
    if (!list.some((it) => !it.sticky)) lines.push(`    ${theme.paint('dim', 'No matches')}`);
    if (s.top > 0) lines.push(`    ${theme.paint('dim', `${theme.sym.up} ${s.top} more`)}`);
    shown.forEach((it, n) => {
      const selected = s.top + n === s.index;
      const label = padEnd(truncate(it.label, labelW, theme.sym.ellipsis), labelW);
      const hintRoom = width - 4 - labelW - (badgeW ? badgeW + 2 : 0) - 2;
      const hint = it.hint && hintRoom >= 8 ? `  ${theme.paint('dim', padEnd(truncateMiddle(it.hint, hintRoom, theme.sym.ellipsis), hintRoom))}` : '';
      const badge = it.badge ? `  ${theme.paint(it.tone || 'dim', padEnd(it.badge, badgeW))}` : '';
      const ptr = selected ? theme.paint('accent bold', theme.sym.pointer) : ' ';
      lines.push(`  ${ptr} ${selected ? theme.paint('accent bold', label) : label}${hint}${badge}`);
    });
    const below = list.length - (s.top + shown.length);
    if (below > 0) lines.push(`    ${theme.paint('dim', `${theme.sym.down} ${below} more`)}`);
    const dot = theme.sym.dot;
    const hotkeys = filterable ? '' : ` ${dot} 1-9 jump`;
    lines.push(theme.paint('dim', `  Enter select ${dot} ${theme.sym.up}${theme.sym.down} move${hotkeys} ${dot} Esc ${state.value ? 'clear filter' : 'back'}${footer ? ` ${dot} ${footer}` : ''}`));
    return lines;
  }

  function onKey(state, key) {
    const list = visibleFor(state);
    const move = (index) => ({ state: settle({ ...state, index }, list.length) });
    switch (key.name) {
      case 'up': return move(state.index <= 0 ? list.length - 1 : state.index - 1);
      case 'down': return move(state.index >= list.length - 1 ? 0 : state.index + 1);
      case 'home': return move(0);
      case 'end': return move(list.length - 1);
      case 'pageup': return move(state.index - maxVisible);
      case 'pagedown': return move(state.index + maxVisible);
      case 'enter': {
        const item = list[clamp(state.index, 0, list.length - 1)];
        return item ? { done: { item } } : { state };
      }
      case 'escape': return state.value ? { state: { ...state, value: '', cursor: 0, index: 0, top: 0 } } : { done: BACK };
      case 'tab': case 'left': case 'right': return { state };
      default: break;
    }
    if (!filterable) {
      const hit = list.find((it) => it.hotkey && key.name === 'char' && key.text === it.hotkey);
      return hit ? { done: { item: hit } } : { state };
    }
    const next = editText({ ...state, cursor: endOf(state.value) }, key);
    if (!next) return { state };
    return { state: settle({ ...next, cursor: endOf(next.value), index: 0, top: 0 }, filterItems(items, next.value).length) };
  }

  return { init: { value: '', cursor: 0, index: 0, top: 0 }, view, onKey };
}

module.exports = { createSelectList, filterItems };
