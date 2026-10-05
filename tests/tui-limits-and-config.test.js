'use strict';
// Character widths and clusters, tiny terminals, input limits, candidate caps,
// private config file, terminal failure paths.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { visibleWidth, graphemes, truncate } = require('../lib/tui/text-width');
const { createTheme } = require('../lib/tui/theme');
const { editText, renderInputBox, MAX_LENGTH } = require('../lib/tui/widgets/input-box');
const { completions } = require('../lib/tui/widgets/path-input');
const { createSession, MIN_COLUMNS } = require('../lib/tui/terminal');
const { buildProjectItems, MAX_CANDIDATES } = require('../lib/tui/flows/project-choices');
const { configDir, recentFile, readRecent, rememberProject } = require('../lib/tui/flows/recent-projects');
const { findRepos } = require('../lib/project-picker');
const { tmpDir } = require('./helpers');
const { makeTerm, tick } = require('./tui-helpers');

const plain = createTheme({ level: 0, unicode: true, attrs: false });
const posix = process.platform !== 'win32';
const key = (name, extra = {}) => ({ name, text: '', ctrl: false, shift: false, meta: false, ...extra });
const type = (state, text) => editText(state, key('char', { text }));

test('widths: wide symbols and emoji sequences are two cells, the UI glyphs stay one', () => {
  for (const [text, width] of [['⚡', 2], ['✅', 2], ['🪄', 2], ['👍🏽', 2], ['🧑‍💻', 2], ['🇯🇵', 2], ['日本', 4], ['é', 1], ['✔', 1], ['⚠', 1], ['❯', 1], ['→', 1], ['…', 1]]) {
    assert.strictEqual(visibleWidth(text), width, text);
  }
  assert.strictEqual(visibleWidth(`a${'👍🏽'}b`), 4);
  assert.deepStrictEqual(graphemes('a👍🏽é🇯🇵'), ['a', '👍🏽', 'é', '🇯🇵']);
  assert.strictEqual(visibleWidth(truncate('👍🏽'.repeat(10), 7)), 7, 'a cluster is never cut in half');
});

test('Backspace, Delete and the arrows move over a whole character cluster', () => {
  const at = (value) => ({ value, cursor: graphemes(value).length });
  assert.strictEqual(editText(at('a👍🏽'), key('backspace')).value, 'a');
  assert.strictEqual(editText(at('aé'), key('backspace')).value, 'a');
  assert.strictEqual(editText(at('x🧑‍💻'), key('backspace')).value, 'x');
  assert.strictEqual(editText(at('x🇯🇵'), key('backspace')).value, 'x');
  assert.strictEqual(editText({ value: '👍🏽a', cursor: 0 }, key('delete')).value, 'a');
  assert.strictEqual(editText(at('👍🏽a'), key('left')).cursor, 1);
  assert.strictEqual(type({ value: '', cursor: 0 }, 'é').cursor, 1);
});

test('control characters typed into a field are ignored; pasted escape sequences are dropped', () => {
  const empty = { value: '', cursor: 0 };
  assert.strictEqual(type(empty, '\x85').value, '');
  assert.strictEqual(type(empty, '‮').value, '');
  const pasted = editText(empty, key('paste', { text: '\x1b[31mred\x1b[0m\x1b]0;title\x07x\r\ny\x1b' }));
  assert.strictEqual(pasted.value, 'redxy');
});

test('a field stops growing at its limit, and rendering a long field is quick', () => {
  const huge = editText({ value: '', cursor: 0 }, key('paste', { text: 'a'.repeat(100000) }));
  assert.strictEqual(graphemes(huge.value).length, MAX_LENGTH);
  assert.strictEqual(editText(huge, key('char', { text: 'b' })).value.length, MAX_LENGTH, 'no room for more');
  const started = process.hrtime.bigint();
  for (let i = 0; i < 300; i += 1) renderInputBox({ theme: plain, width: 60, state: { value: huge.value, cursor: 2000 + (i % 50) } });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1500, `300 renders of a 4096-character field took ${ms}ms`);
  const box = renderInputBox({ theme: plain, width: 60, state: { value: huge.value, cursor: 4096 } });
  assert.ok(box.every((l) => visibleWidth(l) === 60));
});

function sessionFor(term) {
  return createSession({ stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, proc: term.proc, theme: plain });
}

test('a terminal that is too small gets one line, and the real size is used when it grows back', () => {
  const t = makeTerm({ columns: 15, rows: 30 });
  const s = sessionFor(t);
  s.start();
  assert.strictEqual(s.ctx().columns, 15, 'real columns are reported');
  s.draw(['one', 'two', 'three']);
  assert.match(t.screen(), /^Window too sm/);
  assert.strictEqual(t.screen().split('\n').length, 1);
  t.stdout.columns = 80;
  t.stdout.emit('resize');
  assert.strictEqual(t.screen(), 'one\ntwo\nthree');
  t.stdout.rows = 5;
  t.stdout.emit('resize');
  assert.match(t.screen(), /^Window too sm/, 'a change in rows redraws too');
  t.stdout.rows = 12;
  t.stdout.emit('resize');
  assert.strictEqual(t.screen(), 'one\ntwo\nthree');
  assert.strictEqual(s.rows, 12);
  s.close();
  assert.ok(MIN_COLUMNS >= 10);
});

test('the frame never grows past the real number of rows', () => {
  const t = makeTerm({ columns: 60, rows: 10 });
  const s = sessionFor(t);
  s.start();
  s.draw(Array.from({ length: 40 }, (_, i) => `line ${i}`));
  assert.strictEqual(t.screen().split('\n').length, 9);
  s.close();
});

test('stdout EPIPE restores the terminal and exits quietly; later errors are absorbed', async () => {
  const t = makeTerm();
  const s = sessionFor(t);
  s.start();
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  assert.doesNotThrow(() => t.stdout.emit('error', epipe));
  assert.deepStrictEqual(t.stdin.rawCalls, [true, false]);
  assert.deepStrictEqual(t.proc.exitCodes, [1]);
  assert.strictEqual(t.stderrText(), '');
  assert.doesNotThrow(() => t.stdout.emit('error', epipe), 'a second error after restoring does not escape');
  assert.deepStrictEqual(t.proc.exitCodes, [1]);
  await tick();
});

test('a failing stderr does not turn a fatal error into a second crash', () => {
  const t = makeTerm();
  const s = createSession({ stdin: t.stdin, stdout: t.stdout, stderr: { write() { throw new Error('stderr closed'); } }, proc: t.proc, theme: plain });
  s.start();
  assert.doesNotThrow(() => t.proc.emit('uncaughtException', new Error('boom')));
  assert.deepStrictEqual(t.proc.exitCodes, [1]);
  assert.deepStrictEqual(t.stdin.rawCalls, [true, false]);
});

test('the candidate list is capped, and the repository scan stops at the limit', () => {
  const root = tmpDir();
  for (let i = 0; i < MAX_CANDIDATES + 30; i += 1) fs.mkdirSync(path.join(root, `repo-${String(i).padStart(3, '0')}`, '.git'), { recursive: true });
  const items = buildProjectItems({ cwd: root, root, home: tmpDir(), recents: [], theme: plain });
  assert.strictEqual(items.length, MAX_CANDIDATES + 1, 'candidates plus the sticky "Enter a path" entry');
  assert.strictEqual(findRepos([root], 5).length, 5);
  assert.strictEqual(findRepos([root]).length, MAX_CANDIDATES + 30, 'the plain picker is unlimited');
});

test('recent projects: examined entries are capped and dead paths are skipped', () => {
  const xdg = tmpDir();
  const env = { XDG_CONFIG_HOME: xdg };
  const live = tmpDir();
  fs.mkdirSync(path.dirname(recentFile({ env })), { recursive: true });
  const dead = Array.from({ length: 60 }, (_, i) => path.join(xdg, `gone-${i}`));
  fs.writeFileSync(recentFile({ env }), JSON.stringify({ projects: [live, ...dead, tmpDir()] }));
  assert.deepStrictEqual(readRecent({ env }), [live], 'only the first 40 entries are looked at');
  fs.writeFileSync(recentFile({ env }), JSON.stringify({ projects: ['relative', 7, null, live] }));
  assert.deepStrictEqual(readRecent({ env }), [live]);
});

test('recent.json is private to the user, and only an absolute XDG_CONFIG_HOME counts', { skip: !posix && 'POSIX modes' }, () => {
  const base = tmpDir();
  const env = { XDG_CONFIG_HOME: path.join(base, 'cfg') };
  assert.strictEqual(rememberProject(tmpDir(), { env }), true);
  const file = recentFile({ env });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.strictEqual(rememberProject(tmpDir(), { env }), true);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'still private after an update');
  assert.strictEqual(configDir({ XDG_CONFIG_HOME: 'relative/dir' }, '/home/me', 'linux'), path.join('/home/me', '.config', 'ai-sdlc'));
  assert.strictEqual(configDir({ XDG_CONFIG_HOME: '' }, '/home/me', 'linux'), path.join('/home/me', '.config', 'ai-sdlc'));
});

test('the same folder spelled in different case is listed once where the file system ignores case', { skip: !['darwin', 'win32'].includes(process.platform) && 'case-sensitive platform' }, () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'Repo', '.git'), { recursive: true });
  const items = buildProjectItems({ cwd: root, root, home: tmpDir(), recents: [path.join(root, 'Repo'), path.join(root, 'REPO')], theme: plain });
  assert.strictEqual(items.filter((i) => !i.sticky).length, 1);
});

test('Tab completion treats a backslash as part of the name on POSIX', { skip: !posix && 'POSIX only' }, () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'foo\\bar', 'inner'), { recursive: true });
  assert.deepStrictEqual(completions('foo\\ba', { cwd: root, home: tmpDir() }), ['foo\\bar/']);
  assert.deepStrictEqual(completions('foo\\bar/in', { cwd: root, home: tmpDir() }), ['foo\\bar/inner/']);
});

test('folder names containing control characters are not offered for completion', { skip: !posix && 'POSIX names only' }, () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'ok-dir'));
  fs.mkdirSync(path.join(root, 'ok\x1b[2Jevil'));
  assert.deepStrictEqual(completions('ok', { cwd: root, home: tmpDir() }), ['ok-dir/']);
});

test('docs list the signal exit codes', () => {
  for (const file of ['README.md', 'docs/cli.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(text, /130/, file);
    assert.match(text, /143/, file);
  }
});
