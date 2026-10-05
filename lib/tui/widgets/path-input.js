'use strict';
// Path entry with Tab completion over directories. `validate(text)` returns the
// accepted value or throws an Error whose message is shown under the box.
const fs = require('fs');
const path = require('path');
const { BACK } = require('../terminal');
const { editText, renderInputBox, endOf } = require('./input-box');
const { sanitize, stripControl } = require('../sanitize');
const { expandHome } = require('../../project-picker');

const SEP = path.sep === '\\' ? '\\' : '/';
const MAX_SHOWN = 6;

function commonPrefix(list) {
  return list.reduce((acc, s) => {
    let n = 0;
    while (n < acc.length && n < s.length && acc[n] === s[n]) n += 1;
    return acc.slice(0, n);
  });
}

// Directories that complete `value`, as full replacement texts ending in a separator.
function completions(value, { cwd, home }) {
  if (value === '~') return [`~${SEP}`];
  const cut = Math.max(value.lastIndexOf('/'), path.sep === '\\' ? value.lastIndexOf('\\') : -1);
  const dirPart = value.slice(0, cut + 1);
  const prefix = value.slice(cut + 1);
  const base = path.resolve(cwd, expandHome(dirPart || '.', home));
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const isDir = (e) => {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try {
      return fs.statSync(path.join(base, e.name)).isDirectory();
    } catch (_) {
      return false;
    }
  };
  return entries
    .filter((e) => stripControl(e.name) === e.name && isDir(e) && e.name.startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')))
    .map((e) => `${dirPart}${e.name}${SEP}`)
    .sort();
}

function applyTab(state, direction, opts) {
  const comp = state.comp && state.comp.value === state.value ? state.comp : null;
  let matches;
  let index;
  if (comp) {
    matches = comp.matches;
    index = comp.index < 0 ? (direction > 0 ? 0 : matches.length - 1) : (comp.index + direction + matches.length) % matches.length;
  } else {
    matches = completions(state.value, opts);
    if (!matches.length) return { ...state, comp: null, error: '', note: 'no matching folders' };
    if (matches.length === 1) return { ...state, value: matches[0], cursor: endOf(matches[0]), comp: null, error: '', note: '' };
    const common = commonPrefix(matches);
    if (common.length > state.value.length) {
      return { ...state, value: common, cursor: endOf(common), comp: { matches, index: -1, value: common }, error: '', note: '' };
    }
    index = direction > 0 ? 0 : matches.length - 1;
  }
  const value = matches[index];
  return { ...state, value, cursor: endOf(value), comp: { matches, index, value }, error: '', note: '' };
}

function createPathInput({ title = 'Project path', cwd, home, validate, initial = '' }) {
  const opts = { cwd, home };

  function view(state, ctx) {
    const { theme, width } = ctx;
    const lines = [theme.paint('bold', `  ${title}`), ...renderInputBox({ theme, width, state, placeholder: '~/projects/my-app' })];
    if (state.error) lines.push(`  ${theme.paint('err', `${theme.sym.err} ${sanitize(state.error)}`)}`);
    else if (state.note) lines.push(`  ${theme.paint('dim', state.note)}`);
    if (state.comp) {
      const { matches, index } = state.comp;
      const from = Math.max(0, Math.min(index, matches.length - MAX_SHOWN));
      matches.slice(from, from + MAX_SHOWN).forEach((m, n) => {
        const on = from + n === index;
        lines.push(`  ${on ? theme.paint('accent bold', theme.sym.pointer) : ' '} ${on ? theme.paint('accent', sanitize(m)) : theme.paint('dim', sanitize(m))}`);
      });
      if (matches.length > MAX_SHOWN) lines.push(theme.paint('dim', `    ${matches.length} matches`));
    }
    lines.push(theme.paint('dim', `  ${['Enter confirm', 'Tab complete', 'Shift-Tab previous', 'Esc back'].join(` ${theme.sym.dot} `)}`));
    return lines;
  }

  function onKey(state, key) {
    if (key.name === 'tab') return { state: applyTab(state, key.shift ? -1 : 1, opts) };
    if (key.name === 'enter') {
      if (!state.value.trim()) return { state: { ...state, error: 'type or paste a folder path' } };
      try {
        return { done: validate(state.value) };
      } catch (err) {
        return { state: { ...state, error: err.message, comp: null } };
      }
    }
    if (key.name === 'escape') return state.comp ? { state: { ...state, comp: null } } : { done: BACK };
    const next = editText(state, key);
    return { state: next ? { ...next, error: '', note: '', comp: null } : state };
  }

  return { init: { value: stripControl(initial), cursor: endOf(stripControl(initial)), error: '', note: '', comp: null }, view, onKey };
}

module.exports = { createPathInput, completions };
