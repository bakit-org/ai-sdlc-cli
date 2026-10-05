'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createTheme } = require('../lib/tui/theme');
const { BACK } = require('../lib/tui/terminal');
const { stripAnsi, visibleWidth } = require('../lib/tui/text-width');
const { createSelectList, filterItems } = require('../lib/tui/widgets/select-list');
const { editText, renderInputBox } = require('../lib/tui/widgets/input-box');
const { plainTheme, keysOf, drive } = require('./tui-widget-drive');

const ITEMS = [
  { label: 'alpha', hint: '~/work/alpha', value: 'a', badge: 'not installed', tone: 'dim' },
  { label: 'beta', hint: '~/work/beta', value: 'b', badge: 'installed v1.0.0 -> update', tone: 'ok' },
  { label: 'gamma', hint: '~/other/gamma', value: 'g', badge: 'no .git !', tone: 'warn' },
  { label: 'Enter a path...', value: 'path', sticky: true },
];
const list = (extra = {}) => createSelectList({ title: 'Pick', items: ITEMS, ...extra });

test('select list: typing filters, matches label or hint, sticky entry stays', () => {
  assert.deepStrictEqual(filterItems(ITEMS, 'be').map((i) => i.value), ['b', 'path']);
  assert.deepStrictEqual(filterItems(ITEMS, 'other').map((i) => i.value), ['g', 'path']);
  assert.deepStrictEqual(filterItems(ITEMS, 'work alp').map((i) => i.value), ['a', 'path']);
  const r = drive(list(), 'bet');
  assert.match(r.text, /beta/);
  assert.doesNotMatch(r.text, /alpha|gamma/);
  assert.match(r.text, /Enter a path/);
  assert.match(r.text, /❯ bet/, 'the filter text is in the input box');
  assert.deepStrictEqual(drive(list(), 'bet\r').done.item.value, 'b');
  assert.match(drive(list(), 'zzz').text, /No matches/);
});

test('select list: arrows wrap, Home/End jump, Enter picks the highlighted row', () => {
  assert.strictEqual(drive(list(), '\x1b[B\r').done.item.value, 'b');
  assert.strictEqual(drive(list(), '\x1b[A\r').done.item.value, 'path', 'up from the top wraps to the last row');
  assert.strictEqual(drive(list(), '\x1b[F\r').done.item.value, 'path');
  assert.strictEqual(drive(list(), '\x1b[F\x1b[H\r').done.item.value, 'a');
  assert.strictEqual(drive(list(), '\x1b[B\x1b[B\x1b[B\x1b[B\r').done.item.value, 'a', 'down from the last wraps to the first');
  assert.match(drive(list(), '\x1b[B').text, /❯ beta/);
});

test('select list: Esc clears a filter first, then backs out; paste fills the filter', () => {
  assert.strictEqual(drive(list(), 'be\x1b').done, undefined);
  assert.match(drive(list(), 'be\x1b').text, /alpha/);
  assert.strictEqual(drive(list(), 'be\x1b\x1b').done, BACK);
  assert.strictEqual(drive(list(), '\x1b').done, BACK);
  const r = drive(list(), '\x1b[200~gam\x1b[201~');
  assert.match(r.text, /gamma/);
  assert.doesNotMatch(r.text, /alpha/);
  assert.strictEqual(drive(list(), 'be\x7f\x7f').text.includes('alpha'), true, 'backspace widens the filter again');
});

test('select list: scrolls long lists and shows how many are hidden', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ label: `repo-${String(i).padStart(2, '0')}`, value: i }));
  const s = createSelectList({ title: 'Pick', items: many, maxVisible: 5 });
  const top = drive(s, '');
  assert.match(top.text, /↓ 15 more/);
  const end = drive(s, '\x1b[F');
  assert.match(end.text, /repo-19/);
  assert.match(end.text, /↑ 15 more/);
  assert.doesNotMatch(end.text, /repo-00/);
});

test('select list without a filter box: number hotkeys choose, typing does nothing', () => {
  const menu = createSelectList({ title: 'Menu', filterable: false, items: [{ label: 'One', value: 1, hotkey: '1' }, { label: 'Two', value: 2, hotkey: '2' }] });
  assert.strictEqual(drive(menu, '2').done.item.value, 2);
  assert.strictEqual(drive(menu, 'x').done, undefined);
  assert.strictEqual(drive(menu, '\x1b[B\r').done.item.value, 2);
});

test('input editing: insert, backspace, delete, Home/End, Ctrl-A/E/U/W, arrows', () => {
  const run = (bytes) => keysOf(bytes).reduce((s, k) => editText(s, k) || s, { value: '', cursor: 0 });
  assert.deepStrictEqual(run('hello'), { value: 'hello', cursor: 5 });
  assert.strictEqual(run('hello\x7f\x7f').value, 'hel');
  assert.deepStrictEqual(run('hello\x1b[D\x1b[D\x1b[3~'), { value: 'helo', cursor: 3 });
  assert.deepStrictEqual(run('hello\x1b[H'), { value: 'hello', cursor: 0 });
  assert.deepStrictEqual(run('hello\x01\x05'), { value: 'hello', cursor: 5 });
  assert.deepStrictEqual(run('hello world\x17'), { value: 'hello ', cursor: 6 });
  assert.deepStrictEqual(run('hello world\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x15'), { value: 'world', cursor: 0 });
  assert.strictEqual(run('ab\x1b[Dc').value, 'acb');
  assert.strictEqual(run('日本\x7f').value, '日');
  assert.strictEqual(editText({ value: '', cursor: 0 }, keysOf('\t')[0]), null);
});

test('input paste drops line breaks and control characters', () => {
  const s = keysOf('\x1b[200~/tmp/a\r\nb\x07\x1b[201~').reduce((st, k) => editText(st, k) || st, { value: '', cursor: 0 });
  assert.strictEqual(s.value, '/tmp/ab');
});

test('input box: rounded frame, prompt, placeholder, horizontal scroll keeps the caret in view', () => {
  const empty = renderInputBox({ theme: plainTheme, width: 40, state: { value: '', cursor: 0 }, placeholder: 'Type here' });
  assert.deepStrictEqual(empty.map(stripAnsi).map((l) => l.trimEnd()), ['╭──────────────────────────────────────╮', '│ ❯  Type here                         │', '╰──────────────────────────────────────╯']);
  const long = 'x'.repeat(100);
  const box = renderInputBox({ theme: plainTheme, width: 40, state: { value: `${long}END`, cursor: 103 } });
  assert.ok(box.every((l) => visibleWidth(l) === 40), 'frame width never grows');
  assert.match(box[1], /END/);
});

test('ASCII theme draws +--+ boxes and a > prompt', () => {
  const ascii = createTheme({ level: 0, unicode: false, attrs: false });
  const box = renderInputBox({ theme: ascii, width: 20, state: { value: 'a', cursor: 1 } });
  assert.deepStrictEqual(box.map((l) => l.trimEnd()), ['+------------------+', '| > a              |', '+------------------+']);
});

test('colour level 3 paints a gradient border and an inverse caret', () => {
  const t3 = createTheme({ level: 3, unicode: true, attrs: true });
  const box = renderInputBox({ theme: t3, width: 30, state: { value: 'ab', cursor: 1 } });
  assert.match(box[0], /\x1b\[38;2;71;150;228m╭/);
  assert.match(box[0], /\x1b\[38;2;195;103;127m╮\x1b\[0m$/);
  assert.match(box[1], /a\x1b\[7mb\x1b\[27m/);
  const t1 = createTheme({ level: 1, unicode: true, attrs: true });
  assert.match(renderInputBox({ theme: t1, width: 30, state: { value: '', cursor: 0 } })[0], /\x1b\[9[145]m/);
  assert.strictEqual(renderInputBox({ theme: plainTheme, width: 30, state: { value: 'ab', cursor: 1 } })[1].includes('\x1b'), false, 'no escape sequences at level 0');
});

test('the ASCII theme draws only ASCII', () => {
  const ascii = createTheme({ level: 0, unicode: false, attrs: false });
  const c = { theme: ascii, width: 80, rows: 30, columns: 81 };
  const lines = [...createSelectList({ title: 'Pick', items: ITEMS }).view({ value: '', cursor: 0, index: 1, top: 0 }, c), ...createSelectList({ title: 'M', items: ITEMS, filterable: false }).view({ value: '', cursor: 0, index: 0, top: 0 }, c)];
  assert.doesNotMatch(lines.join('\n'), /[^\x00-\x7f]/);
});
