'use strict';
// Single-line text editing (pure) and the rounded input box that shows it.
const { clusterWidth, graphemes } = require('../text-width');
const { sanitize, stripControl } = require('../sanitize');
const { renderBox } = require('./panel');

const MAX_LENGTH = 4096; // characters (grapheme clusters) a field accepts

const cleanPaste = (text) => stripControl(text);
const endOf = (value) => graphemes(value).length;

// state: { value, cursor } with cursor counted in characters (clusters: an emoji
// with a skin tone or a letter with accents is one character for the caret and Backspace).
// Returns the new state, or null when the key is not a text-editing key.
function editText(state, key) {
  const chars = graphemes(state.value);
  const at = Math.min(state.cursor, chars.length);
  const make = (arr, cursor) => ({ ...state, value: arr.join(''), cursor });
  const insert = (text) => {
    const add = graphemes(text).slice(0, Math.max(0, MAX_LENGTH - chars.length));
    const before = [...chars.slice(0, at), ...add];
    return { ...state, value: [...before, ...chars.slice(at)].join(''), cursor: endOf(before.join('')) };
  };

  if (key.name === 'char' && !key.ctrl && !key.meta) return stripControl(key.text) === key.text ? insert(key.text) : make(chars, at);
  if (key.name === 'paste') return insert(cleanPaste(key.text));
  if (key.ctrl) {
    if (key.name === 'a') return make(chars, 0);
    if (key.name === 'e') return make(chars, chars.length);
    if (key.name === 'u') return make(chars.slice(at), 0);
    if (key.name === 'w') {
      let start = at;
      while (start > 0 && chars[start - 1] === ' ') start -= 1;
      while (start > 0 && chars[start - 1] !== ' ') start -= 1;
      return make([...chars.slice(0, start), ...chars.slice(at)], start);
    }
    return null;
  }
  switch (key.name) {
    case 'backspace': return at > 0 ? make([...chars.slice(0, at - 1), ...chars.slice(at)], at - 1) : make(chars, at);
    case 'delete': return make([...chars.slice(0, at), ...chars.slice(at + 1)], at);
    case 'left': return make(chars, Math.max(0, at - 1));
    case 'right': return make(chars, Math.min(chars.length, at + 1));
    case 'home': return make(chars, 0);
    case 'end': return make(chars, chars.length);
    default: return null;
  }
}

// The slice of `chars` that fits `room` cells and keeps the caret visible.
// Walks outward from the caret, so the cost depends on the window, not the text length.
function windowAround(chars, cursor, room) {
  let start = cursor;
  let used = 0;
  while (start > 0) {
    const w = clusterWidth(chars[start - 1]);
    if (used + w > room - 1) break;
    used += w;
    start -= 1;
  }
  let end = cursor;
  while (end < chars.length) {
    const w = clusterWidth(chars[end]);
    if (used + w > room) break;
    used += w;
    end += 1;
  }
  return { start, end };
}

// Returns the box as lines.
function renderInputBox({ theme, width, state, placeholder = '', title = '' }) {
  const prompt = `${theme.paint('accent bold', theme.sym.pointer)} `;
  const inner = Math.max(12, Math.min(width, 100)) - 4;
  const room = inner - 2;
  const chars = graphemes(state.value);
  const cursor = Math.min(state.cursor, chars.length);
  let body;
  if (!chars.length) body = `${theme.caret(' ')}${theme.paint('dim', sanitize(placeholder))}`;
  else {
    const { start, end } = windowAround(chars, cursor, room);
    const under = cursor < end ? sanitize(chars[cursor]) : ' ';
    body = `${sanitize(chars.slice(start, cursor).join(''))}${theme.caret(under)}${sanitize(chars.slice(Math.min(cursor + 1, end), end).join(''))}`;
  }
  return renderBox({ theme, width, title, rows: [`${prompt}${body}`] });
}

module.exports = { editText, renderInputBox, cleanPaste, endOf, MAX_LENGTH };
