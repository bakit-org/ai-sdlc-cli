'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createTheme } = require('../lib/tui/theme');
const { BACK } = require('../lib/tui/terminal');
const { stripAnsi, visibleWidth } = require('../lib/tui/text-width');
const { createPathInput, completions } = require('../lib/tui/widgets/path-input');
const { createConfirm } = require('../lib/tui/widgets/confirm');
const { renderProgress } = require('../lib/tui/widgets/progress-bar');
const { renderPanel } = require('../lib/tui/widgets/panel');
const { spinnerLine } = require('../lib/tui/widgets/spinner');
const { validateTarget } = require('../lib/project-picker');
const { tmpDir } = require('./helpers');
const { plainTheme, ctx, drive } = require('./tui-widget-drive');

function fixtureTree() {
  const root = tmpDir();
  for (const d of ['projects/app-one', 'projects/app-two', 'projects/notes', '.hidden']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'app-file.txt'), 'x');
  return root;
}

test('path completion: single match completes with a separator, several complete the common prefix then cycle', () => {
  const root = fixtureTree();
  const home = tmpDir();
  const pi = (initial) => createPathInput({ cwd: root, home, validate: (t) => validateTarget(t, { cwd: root, home }), initial });
  assert.strictEqual(drive(pi('projects/no'), '\t').state.value, 'projects/notes/');
  assert.strictEqual(drive(pi('projects/a'), '\t').state.value, 'projects/app-', 'common prefix of app-one / app-two (files are not offered)');
  const first = drive(pi('projects/a'), '\t');
  assert.match(first.text, /app-one\//);
  assert.match(first.text, /app-two\//);
  assert.doesNotMatch(first.text, /app-file/);
  assert.strictEqual(drive(pi('projects/a'), '\t\t').state.value, 'projects/app-one/');
  assert.strictEqual(drive(pi('projects/a'), '\t\t\t').state.value, 'projects/app-two/');
  assert.strictEqual(drive(pi('projects/a'), '\t\t\x1b[Z').state.value, 'projects/app-two/', 'Shift-Tab goes back');
  assert.strictEqual(drive(pi('projects/zzz'), '\t').state.note, 'no matching folders');
  assert.deepStrictEqual(completions('', { cwd: root, home }), ['projects/']);
  assert.deepStrictEqual(completions('.', { cwd: root, home }), ['.hidden/'], 'hidden folders only when asked for with a dot');
});

test('path completion understands ~ and typing after a completion edits the text', () => {
  const root = tmpDir();
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'code', 'site'), { recursive: true });
  const pi = createPathInput({ cwd: root, home, validate: () => ({}) });
  assert.strictEqual(drive(pi, '~\t').state.value, '~/');
  assert.strictEqual(drive(pi, '~/c\t').state.value, '~/code/');
  assert.strictEqual(drive(pi, '~/code/\t').state.value, '~/code/site/');
  const typed = drive(pi, '~/c\tx');
  assert.strictEqual(typed.state.value, '~/code/x');
  assert.strictEqual(typed.state.comp, null);
});

test('path input rejects ~, files, missing paths and roots with an inline message and stays open', () => {
  const root = tmpDir();
  const home = tmpDir();
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'x');
  const pi = () => createPathInput({ cwd: root, home, validate: (t) => validateTarget(t, { cwd: root, home }) });
  const bad = (typed) => drive(pi(), `${typed}\r`);
  const home1 = bad('~');
  assert.strictEqual(home1.done, undefined);
  assert.match(home1.text, /✖ refusing to install into the home directory/);
  assert.match(bad(file).text, /not a directory/);
  assert.match(bad(path.join(root, 'missing')).text, /does not exist/);
  assert.match(bad(path.parse(root).root).text, /filesystem root/);
  assert.match(bad('   ').text, /type or paste a folder path/);
  const edited = drive(pi(), `~\rx`);
  assert.doesNotMatch(edited.text, /✖/, 'the message goes away once you type again');
  const ok = drive(pi(), `${root}\r`);
  assert.strictEqual(ok.done.dir, root);
  assert.strictEqual(drive(pi(), '\x1b').done, BACK);
  const pickList = fixtureTree();
  const withList = createPathInput({ cwd: pickList, home, validate: () => ({}), initial: 'projects/a' });
  assert.strictEqual(drive(withList, '\t\x1b').done, undefined, 'first Esc only closes the candidate list when open');
  assert.strictEqual(drive(withList, '\t\x1b\x1b').done, BACK);
});

test('confirm: Enter or y confirms, Esc or n steps back, d toggles details, arrows scroll', () => {
  const body = (state) => (state.expanded ? Array.from({ length: 40 }, (_, i) => `row ${i}`) : ['summary']);
  const c = () => createConfirm({ title: 'Review', body, detailsToggle: true });
  assert.strictEqual(drive(c(), '\r').done, true);
  assert.strictEqual(drive(c(), 'y').done, true);
  assert.strictEqual(drive(c(), '\x1b').done, BACK);
  assert.strictEqual(drive(c(), 'n').done, BACK);
  assert.match(drive(c(), '').text, /summary/);
  assert.match(drive(c(), '').text, /d show full list/);
  const open = drive(c(), 'd', ctx(plainTheme, { rows: 14 }));
  assert.match(open.text, /row 0/);
  assert.match(open.text, /more below/);
  assert.match(open.text, /d hide full list/);
  const scrolled = drive(c(), 'd\x1b[6~', ctx(plainTheme, { rows: 14 }));
  assert.match(scrolled.text, /more above/);
  assert.doesNotMatch(scrolled.text, /row 0\b/);
  assert.strictEqual(drive(createConfirm({ title: 'T', body }), 'd').state.expanded, false, 'no toggle unless enabled');
});

test('progress bar, panel and spinner render plain text at level 0', () => {
  const bar = stripAnsi(renderProgress({ theme: plainTheme, width: 80, done: 5, total: 10, label: '.claude/agents/x.md' }));
  assert.match(bar, /█+░+ +50%  \.claude\/agents\/x\.md/);
  assert.match(stripAnsi(renderProgress({ theme: plainTheme, width: 80, done: 0, total: 0 })), /100%/);
  const panel = renderPanel({ theme: plainTheme, width: 30, title: 'Done', lines: ['one', 'two'] }).map(stripAnsi);
  assert.deepStrictEqual(panel.map(visibleWidth), [30, 30, 30, 30]);
  assert.match(panel[0], /^╭─ Done ─+╮$/);
  assert.match(panel[1], /^│ one +│$/);
  assert.strictEqual(stripAnsi(spinnerLine({ theme: plainTheme, tick: 1, text: 'working' })), '  ⠙ working');
  const ascii = createTheme({ level: 0, unicode: false, attrs: false });
  assert.strictEqual(stripAnsi(renderProgress({ theme: ascii, width: 60, done: 1, total: 2 })).includes('#'), true);
});
