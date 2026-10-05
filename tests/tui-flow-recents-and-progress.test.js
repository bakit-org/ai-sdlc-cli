'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/commands');
const { readRecent, rememberProject, configDir, recentFile } = require('../lib/tui/flows/recent-projects');
const { applyPlan } = require('../lib/apply-plan');
const { tmpDir, makeBundle, writeBundle, newProject, exists, read } = require('./helpers');
const { makeTerm, KEYS } = require('./tui-helpers');

const ESC = /\x1b\[/;
const setup = () => ({ bundle: writeBundle(tmpDir(), makeBundle()), home: tmpDir(), xdg: tmpDir() });
const termFor = (xdg, env = {}) => makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: xdg, ...env } });

test('recent projects: only paths, newest first, deduplicated, written atomically; failures are ignored', () => {
  const xdg = tmpDir();
  const env = { XDG_CONFIG_HOME: xdg };
  const a = tmpDir();
  const b = tmpDir();
  assert.strictEqual(rememberProject(a, { env }), true);
  assert.strictEqual(rememberProject(b, { env }), true);
  assert.strictEqual(rememberProject(a, { env }), true);
  assert.deepStrictEqual(readRecent({ env }), [a, b]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(recentFile({ env }), 'utf8')), { projects: [a, b] });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(recentFile({ env }))), ['recent.json'], 'no temp files left behind');
  fs.rmSync(b, { recursive: true });
  assert.deepStrictEqual(readRecent({ env }), [a], 'vanished folders are dropped');
  fs.writeFileSync(recentFile({ env }), '{ not json');
  assert.deepStrictEqual(readRecent({ env }), []);
  assert.strictEqual(rememberProject(a, { env }), true, 'a corrupt file is replaced');
  assert.strictEqual(rememberProject('relative/path', { env }), false);
  const blocked = tmpDir();
  fs.writeFileSync(path.join(blocked, 'ai-sdlc'), 'a file where the directory should be');
  assert.strictEqual(rememberProject(a, { env: { XDG_CONFIG_HOME: blocked } }), false, 'write failures are swallowed');
  assert.deepStrictEqual(readRecent({ env: { XDG_CONFIG_HOME: blocked } }), []);
});

test('config directory: XDG_CONFIG_HOME, APPDATA on Windows, else ~/.config', () => {
  assert.strictEqual(configDir({ XDG_CONFIG_HOME: '/x' }, '/h', 'linux'), path.join('/x', 'ai-sdlc'));
  assert.strictEqual(configDir({}, '/h', 'linux'), path.join('/h', '.config', 'ai-sdlc'));
  assert.strictEqual(configDir({ APPDATA: '/a' }, '/h', 'win32'), path.join('/a', 'ai-sdlc'));
});

test('the picker lists recent projects first, flags folders without .git, and drops stale entries', async () => {
  const { bundle, xdg, home } = setup();
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'zeta-app', '.git'), { recursive: true });
  const plain = tmpDir();
  rememberProject(plain, { env: { XDG_CONFIG_HOME: xdg } });
  rememberProject(path.join(root, 'gone'), { env: { XDG_CONFIG_HOME: xdg } });
  const term = termFor(xdg);
  const done = run(['init', '--root', root, '--from-bundle', bundle], term.runEnv({ cwd: root, home }));
  await term.waitFor(/Select the project/);
  const lines = term.screen().split('\n');
  const rows = lines.filter((l) => /not installed|no \.git/.test(l));
  assert.match(rows[0], new RegExp(path.basename(plain)));
  assert.match(rows[0], /no \.git ⚠/);
  assert.match(rows[1], /zeta-app/);
  assert.doesNotMatch(term.screen(), /gone/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
});

test('applyPlan reports progress per change and ignores a failing callback', () => {
  const project = newProject();
  const plan = {
    actions: [
      { kind: 'file', action: 'create', path: 'a.txt', write: Buffer.from('a') },
      { kind: 'manifest', action: 'create', path: '.claude/ai-sdlc.manifest.json', write: Buffer.from('{}') },
      { kind: 'file', action: 'create', path: 'b.txt', write: Buffer.from('b') },
      { kind: 'file', action: 'unchanged', path: 'c.txt' },
    ],
  };
  const lock = { record() {}, keep() {} };
  const seen = [];
  applyPlan(project, plan, 'install', lock, { onProgress: (p) => seen.push(p) });
  assert.deepStrictEqual(seen, [
    { done: 0, total: 3, path: null },
    { done: 1, total: 3, path: 'a.txt' },
    { done: 2, total: 3, path: 'b.txt' },
    { done: 3, total: 3, path: '.claude/ai-sdlc.manifest.json' },
  ], 'the manifest is written last');
  const again = newProject();
  applyPlan(again, plan, 'install', lock, { onProgress: () => { throw new Error('display broke'); } });
  assert.strictEqual(read(again, 'a.txt'), 'a');
  assert.ok(exists(again, '.claude/ai-sdlc.manifest.json'));
  applyPlan(newProject(), plan, 'install', lock);
});
