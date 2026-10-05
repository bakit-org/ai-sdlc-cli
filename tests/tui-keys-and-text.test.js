'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createKeyParser } = require('../lib/tui/keys');
const { stripAnsi, visibleWidth, truncate, truncateMiddle } = require('../lib/tui/text-width');
const { createTheme, detectUnicode } = require('../lib/tui/theme');

function parse(...chunks) {
  const out = [];
  const p = createKeyParser((k) => out.push(k), { escapeMs: 0 });
  chunks.forEach((c) => p.feed(c));
  return out;
}
const names = (keys) => keys.map((k) => (k.name === 'char' ? k.text : k.ctrl ? `ctrl-${k.name}` : k.shift ? `shift-${k.name}` : k.name));

test('arrows, home/end, delete and paging in CSI and application forms', () => {
  assert.deepStrictEqual(names(parse('\x1b[A\x1b[B\x1b[C\x1b[D')), ['up', 'down', 'right', 'left']);
  assert.deepStrictEqual(names(parse('\x1bOA\x1bOB\x1bOH\x1bOF')), ['up', 'down', 'home', 'end']);
  assert.deepStrictEqual(names(parse('\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[7~\x1b[8~')), ['home', 'end', 'home', 'end', 'home', 'end']);
  assert.deepStrictEqual(names(parse('\x1b[3~\x1b[5~\x1b[6~')), ['delete', 'pageup', 'pagedown']);
});

test('enter, escape, tab, shift-tab, backspace', () => {
  assert.deepStrictEqual(names(parse('\r', '\x1b', '\t', '\x1b[Z', '\x7f', '\b')), ['enter', 'escape', 'tab', 'shift-tab', 'backspace', 'backspace']);
});

test('control keys carry ctrl and the letter', () => {
  const keys = parse('\x03\x15\x17\x01\x05');
  assert.deepStrictEqual(keys.map((k) => [k.name, k.ctrl]), [['c', true], ['u', true], ['w', true], ['a', true], ['e', true]]);
});

test('CRLF is one Enter, also when split across chunks; a bare LF is Enter', () => {
  assert.deepStrictEqual(names(parse('\r\n')), ['enter']);
  assert.deepStrictEqual(names(parse('\r', '\n')), ['enter']);
  assert.deepStrictEqual(names(parse('\n')), ['enter']);
  assert.deepStrictEqual(names(parse('\r\n\r\n')), ['enter', 'enter']);
});

test('printable text, including multi-byte characters, arrives one key per character', () => {
  assert.deepStrictEqual(names(parse('ab', 'é', '日本', '😀')), ['a', 'b', 'é', '日', '本', '😀']);
});

test('bracketed paste is one event, even when split across chunks, and keys after it still parse', () => {
  const keys = parse('\x1b[200~hello ', 'wor', 'ld\x1b[201~x');
  assert.deepStrictEqual(keys.map((k) => [k.name, k.text]), [['paste', 'hello world'], ['char', 'x']]);
  assert.strictEqual(parse('\x1b[200~a\r\nb\x1b[201~')[0].text, 'a\r\nb');
  assert.deepStrictEqual(names(parse('\x1b[200~ab\x1b', '[201~')), ['paste']);
});

test('an escape sequence cut off at the end of a chunk waits for the rest', () => {
  assert.deepStrictEqual(names(parse('\x1b[', 'A')), ['up']);
  assert.deepStrictEqual(names(parse('\x1b[1;', '5C')), ['ctrl-right']);
});

test('modifier forms and Alt chords', () => {
  const [k] = parse('\x1b[1;5C');
  assert.strictEqual(k.name, 'right');
  assert.strictEqual(k.ctrl, true);
  const [alt] = parse('\x1bb');
  assert.deepStrictEqual([alt.name, alt.text, alt.meta], ['char', 'b', true]);
});

test('stripAnsi and visibleWidth ignore colour sequences and count wide characters as two', () => {
  assert.strictEqual(stripAnsi('\x1b[38;2;1;2;3mhi\x1b[0m'), 'hi');
  assert.strictEqual(visibleWidth('\x1b[1mabc\x1b[0m'), 3);
  assert.strictEqual(visibleWidth('日本'), 4);
  assert.strictEqual(visibleWidth('é'), 1);
  assert.strictEqual(visibleWidth('✔ ok'), 4);
});

test('truncate keeps the width, adds an ellipsis and closes open styling', () => {
  assert.strictEqual(truncate('abcdefghij', 6), 'abcde…');
  assert.strictEqual(truncate('short', 10), 'short');
  const cut = truncate('\x1b[31mabcdefghij\x1b[0m', 5);
  assert.strictEqual(visibleWidth(cut), 5);
  assert.ok(cut.includes('\x1b[0m'));
  assert.strictEqual(visibleWidth(truncate('日本語日本語', 7)), 7);
  assert.strictEqual(truncate('abcdef', 5, '...'), 'ab...');
});

test('unicode is off for TERM=linux, TERM=dumb and non-UTF-8 locales', () => {
  assert.strictEqual(detectUnicode({ TERM: 'linux', LANG: 'en_US.UTF-8' }), false);
  assert.strictEqual(detectUnicode({ TERM: 'dumb' }), false);
  assert.strictEqual(detectUnicode({ LANG: 'C' }), false);
  assert.strictEqual(detectUnicode({ LC_ALL: 'POSIX', LANG: 'en_US.UTF-8' }), false);
  assert.strictEqual(detectUnicode({ LANG: 'en_US.UTF-8' }), true);
  assert.strictEqual(detectUnicode({ LANG: 'en_US.utf8', TERM: 'xterm-256color' }), true);
  assert.strictEqual(detectUnicode({}, 'win32'), false);
  assert.strictEqual(detectUnicode({ WT_SESSION: 'x' }, 'win32'), true);
});

test('theme: NO_COLOR gives plain text, truecolor and 16-colour give escape sequences', () => {
  const stream = { isTTY: true };
  const none = createTheme({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' }, stream });
  assert.strictEqual(none.level, 0);
  assert.strictEqual(none.paint('ok', 'x'), 'x');
  assert.strictEqual(none.gradient('abc'), 'abc');
  const full = createTheme({ env: { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, stream });
  assert.strictEqual(full.level, 3);
  assert.match(full.paint('ok', 'x'), /^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[0m$/);
  assert.match(full.gradient('abc'), /\x1b\[38;2;71;150;228ma/);
  const basic = createTheme({ env: { TERM: 'xterm', LANG: 'en_US.UTF-8' }, stream });
  assert.strictEqual(basic.level, 1);
  assert.strictEqual(basic.paint('err', 'x'), '\x1b[31mx\x1b[0m');
  assert.strictEqual(createTheme({ env: { LANG: 'en_US.UTF-8' }, stream: { isTTY: false } }).level, 0);
});

test('theme: ASCII symbols and box when unicode is off', () => {
  const t = createTheme({ env: { TERM: 'linux' }, stream: { isTTY: true }, level: 0 });
  assert.strictEqual(t.unicode, false);
  assert.deepStrictEqual([t.sym.pointer, t.sym.ok, t.box.tl, t.box.h, t.box.v], ['>', '+', '+', '-', '|']);
  assert.strictEqual(t.caret('x'), '\x1b[7mx\x1b[27m', 'a real terminal still gets an inverse caret');
  assert.strictEqual(createTheme({ env: {}, stream: { isTTY: false }, level: 0 }).caret('x'), 'x');
});

test('truncateMiddle keeps both ends of a path', () => {
  const p = '/Users/someone/Projects/client/very-long-project-name';
  const cut = truncateMiddle(p, 30);
  assert.strictEqual(visibleWidth(cut), 30);
  assert.ok(cut.startsWith('/Users'));
  assert.ok(cut.endsWith('project-name'));
  assert.ok(cut.includes('…'));
  assert.strictEqual(truncateMiddle('/short', 30), '/short');
  assert.strictEqual(truncateMiddle(p, 1), '…');
  assert.strictEqual(visibleWidth(truncateMiddle('日本語日本語日本語', 9)), 9);
});
