'use strict';
// Data from disk must reach the terminal as visible text, never as control sequences.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/commands');
const { sanitize, stripControl } = require('../lib/tui/sanitize');
const { createTheme } = require('../lib/tui/theme');
const { truncate, truncateMiddle, visibleWidth, stripAnsi } = require('../lib/tui/text-width');
const { createSelectList } = require('../lib/tui/widgets/select-list');
const { reviewBody } = require('../lib/tui/flows/review-view');
const { doctorView, planView, installedPanel } = require('../lib/tui/flows/result-views');
const semver = require('../lib/semver');
const { readManifest } = require('../lib/manifest');
const { tmpDir, makeBundle, writeBundle, newProject, runCli, read } = require('./helpers');
const { makeTerm, KEYS } = require('./tui-helpers');

const EVIL = 'x\x1b[2J\x1b]0;pwned\x07\n\r\t\x7f\x85y';
const plain = createTheme({ level: 0, unicode: true, attrs: false });
const NO_CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
const posix = process.platform !== 'win32';

test('sanitize shows control characters instead of sending them', () => {
  assert.strictEqual(sanitize('a\x1b[2Jb'), 'a^[[2Jb');
  assert.strictEqual(sanitize('1\n2\r3\t4'), '1\\n2\\r3\\t4');
  assert.strictEqual(sanitize('\x00\x07\x1f\x7f'), '^@^G^_^?');
  assert.strictEqual(sanitize('\x9b31m\x85'), '\\u009b31m\\u0085');
  assert.strictEqual(sanitize('a‮b '), 'a\\u202eb\\u2028', 'bidi override and line separator');
  assert.strictEqual(sanitize('plain ✔ 日本'), 'plain ✔ 日本');
  assert.strictEqual(stripControl('\x1b[31mred\x1b[0m\x1b]0;title\x07!\x1b\\x\x00'), 'red!x');
});

test('truncate never cuts inside an escape sequence (CSI or OSC)', () => {
  const link = '\x1b]8;;https://example.invalid/some/long/target\x07click here please\x1b]8;;\x07';
  for (let max = 1; max < visibleWidth(link) + 2; max += 1) {
    const cut = truncate(`\x1b[1m${link}\x1b[0m tail`, max);
    assert.doesNotMatch(cut, /\x1b\](?![^\x07\x1b]*(?:\x07|\x1b\\))/, `max ${max}: an OSC was split`);
    assert.doesNotMatch(cut, /\x1b\[[0-?]*$/, `max ${max}: a CSI was split`);
    assert.ok(visibleWidth(cut) <= max, `max ${max}`);
  }
  assert.strictEqual(stripAnsi('a\x1b]0;title\x07b\x1b[31mc'), 'abc');
  assert.strictEqual(visibleWidth('\x1b]0;a long title\x07ab'), 2);
});

test('every widget and view renders hostile data without control characters', () => {
  const list = createSelectList({ title: EVIL, notice: EVIL, items: [{ label: EVIL, hint: EVIL, badge: EVIL, tone: 'ok', value: 1 }] });
  const ctx = { theme: plain, width: 80, rows: 30, columns: 81 };
  const frames = [list.view({ value: '', cursor: 0, index: 0, top: 0 }, ctx)];
  const plan = { payloadVersion: EVIL, actions: [{ kind: 'file', action: EVIL, path: EVIL, detail: EVIL, write: Buffer.from('x') }] };
  frames.push(reviewBody({ theme: plain, project: EVIL, plan, bundle: { files: [], hooks: [] }, hasGit: false, warnings: [EVIL] }, { expanded: true }));
  frames.push(doctorView({ theme: plain, width: 80, project: EVIL, warnings: [EVIL], report: { ok: false, checks: [{ name: EVIL, status: 'fail', detail: EVIL }] } }));
  frames.push(planView({ theme: plain, width: 80, command: 'update', project: EVIL, plan, dryRun: false }));
  frames.push(installedPanel({ theme: plain, width: 80, project: EVIL, plan, version: EVIL }));
  for (const lines of frames) {
    for (const line of lines) assert.doesNotMatch(line, NO_CONTROLS, JSON.stringify(line));
  }
  assert.match(frames[0].join('\n'), /x\^\[\[2J\^\[\]0;pwned\^G\\n\\r\\t\^\?\\u0085y/);
});

test('strict versions: only real semantic versions are accepted', () => {
  for (const ok of ['1.0.0', '10.20.30', '1.0.0-beta.1', '1.0.0+build.5', '2.1.0-rc.1+sha.abc']) assert.strictEqual(semver.isStrict(ok), true, ok);
  for (const bad of ['1.0', '1.0.0\x1b[2J', '1.0.0-\x07', ' 1.0.0', '1.0.0 ', 'v1.0.0', '1.0.0-', 1, null, `1.0.0-${'a'.repeat(80)}`]) assert.strictEqual(semver.isStrict(bad), false, String(bad));
});

test('a bundle or an installed manifest with a hostile version is rejected', async () => {
  const bundle = makeBundle({ version: '1.0.0-\x1b[2J' });
  const r = await runCli(['install', '--project', newProject(), '--from-bundle', writeBundle(tmpDir(), bundle), '--yes']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /not a version/);
  const project = newProject();
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', writeBundle(tmpDir(), makeBundle()), '--yes'])).code, 0);
  const file = path.join(project, '.claude/ai-sdlc.manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.payload_version = '9.9.9\x1b]0;pwned\x07';
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => readManifest(project), /payload_version is missing or not a version/);
});

test('menu and picker show a warning row for an untrustworthy manifest instead of crashing', async () => {
  const bundle = writeBundle(tmpDir(), makeBundle());
  const root = tmpDir();
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', bundle, '--yes'])).code, 0);
  const file = path.join(project, '.claude/ai-sdlc.manifest.json');
  const manifest = JSON.parse(read(project, '.claude/ai-sdlc.manifest.json'));
  manifest.payload_version = '9.9.9\x1b]0;pwned\x07';
  fs.writeFileSync(file, JSON.stringify(manifest));
  const env = { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: tmpDir() };

  const menu = makeTerm({ env });
  const done = run([], menu.runEnv({ cwd: project, home: tmpDir() }));
  await menu.waitFor(/What would you like to do/);
  assert.match(menu.plain(), /⚠ manifest cannot be trusted: installed manifest/);
  assert.doesNotMatch(menu.raw(), /\x1b\]|\x07/);
  await menu.send('5');
  assert.strictEqual(await done, 0);

  const picker = makeTerm({ env });
  const wizard = run(['init', '--root', root, '--from-bundle', bundle], picker.runEnv({ cwd: root, home: tmpDir() }));
  await picker.waitFor(/Select the project/);
  assert.match(picker.screen(), /app\s+.*manifest invalid ⚠/);
  await picker.send(KEYS.esc);
  assert.strictEqual(await wizard, 1);
});

test('a repository whose name is an escape sequence is shown as visible text and can be installed', { skip: !posix && 'POSIX file names only' }, async () => {
  const root = tmpDir();
  const name = 'evil\x1b[2J\x1b]0;pwned\x07';
  fs.mkdirSync(path.join(root, name, '.git'), { recursive: true });
  const env = { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: tmpDir() };
  const term = makeTerm({ env });
  const done = run(['init', '--root', root, '--from-bundle', writeBundle(tmpDir(), makeBundle())], term.runEnv({ cwd: root, home: tmpDir() }));
  await term.waitFor(/Select the project/);
  assert.match(term.screen(), /evil\^\[\[2J\^\[\]0;pwned\^G/);
  await term.send(KEYS.enter);
  await term.waitFor(/Review/);
  assert.match(term.screen(), /evil\^\[\[2J/);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  for (const bad of ['\x1b[2J', '\x1b]', '\x07']) assert.ok(!term.raw().includes(bad), `output contains ${JSON.stringify(bad)}`);
  const recent = fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'ai-sdlc', 'recent.json'), 'utf8');
  assert.ok(JSON.parse(recent).projects[0].endsWith(name), 'the real path is remembered unchanged');

  const again = makeTerm({ env });
  const second = run(['init', '--root', tmpDir(), '--from-bundle', writeBundle(tmpDir(), makeBundle())], again.runEnv({ cwd: root, home: tmpDir() }));
  await again.waitFor(/Select the project/);
  assert.match(again.screen(), /evil\^\[\[2J.*installed v1\.0\.0/, 'a remembered project is shown safely too');
  assert.ok(!again.raw().includes('\x1b]'));
  await again.send(KEYS.esc);
  assert.strictEqual(await second, 1);
});

test('truncateMiddle and widths keep hostile-free output within the width', () => {
  const cut = truncateMiddle(sanitize(`/home/${EVIL}/project`), 30);
  assert.ok(visibleWidth(cut) <= 30);
  assert.doesNotMatch(cut, NO_CONTROLS);
});
