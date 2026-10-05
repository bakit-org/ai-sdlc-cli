'use strict';
// Data from disk, from manifests or from the user must never reach the
// terminal as control sequences. sanitize() turns control characters into
// visible escapes; it is applied to data strings only, never to the colour
// codes the theme adds around them.
// Controls: C0, DEL, C1, line/paragraph separators and bidirectional overrides.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
// Whole escape sequences (CSI, OSC, two-character) in text that was typed or pasted.
const ESCAPE_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function visible(ch) {
  const code = ch.charCodeAt(0);
  if (ch === '\x1b') return '^[';
  if (ch === '\n') return '\\n';
  if (ch === '\r') return '\\r';
  if (ch === '\t') return '\\t';
  if (code < 0x20) return `^${String.fromCharCode(code + 64)}`;
  if (code === 0x7f) return '^?';
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

const sanitize = (value) => String(value).replace(CONTROL, visible);

// For text typed or pasted into a field: escape sequences and control characters are dropped.
const stripControl = (value) => String(value).replace(ESCAPE_SEQUENCE, '').replace(CONTROL, '');

module.exports = { sanitize, stripControl };
