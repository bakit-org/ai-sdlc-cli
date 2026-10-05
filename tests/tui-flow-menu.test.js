'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/commands');
const { tmpDir, makeBundle, writeBundle, newProject, exists, runCli } = require('./helpers');
const { makeTerm, KEYS } = require('./tui-helpers');
const { SHOW_CURSOR } = require('../lib/tui/terminal');

const ESC = /\x1b\[/;
const setup = () => ({ bundle: writeBundle(tmpDir(), makeBundle()), home: tmpDir(), xdg: tmpDir() });
const termFor = (xdg, env = {}) => makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: xdg, ...env } });

test('bare ai-sdlc on a terminal opens the menu with the state of the current folder; Quit exits 0', async () => {
  const { xdg, home } = setup();
  const cwd = newProject();
  const term = termFor(xdg);
  const done = run([], term.runEnv({ cwd, home }));
  await term.waitFor(/What would you like to do\?/);
  const screen = term.screen();
  for (const label of ['Install', 'Update', 'Doctor', 'Uninstall', 'Quit']) assert.match(screen, new RegExp(label));
  assert.match(term.plain(), /Status\s+ai-sdlc not installed/);
  await term.send('5');
  assert.strictEqual(await done, 0);
  assert.deepStrictEqual(term.stdin.rawCalls, [true, false]);
  assert.ok(term.raw().includes(SHOW_CURSOR));
});

test('menu: Esc quits, Ctrl-C is a cancel (exit 1), and nothing is written', async () => {
  const { xdg, home } = setup();
  const cwd = newProject();
  const a = termFor(xdg);
  const first = run([], a.runEnv({ cwd, home }));
  await a.waitFor(/What would you like to do/);
  await a.send(KEYS.esc);
  assert.strictEqual(await first, 0);
  const b = termFor(xdg);
  const second = run([], b.runEnv({ cwd, home }));
  await b.waitFor(/What would you like to do/);
  await b.send(KEYS.ctrlC);
  assert.strictEqual(await second, 1);
  assert.deepStrictEqual(fs.readdirSync(cwd), ['.git']);
});

test('menu in an installed folder shows the version; Doctor runs the doctor view for it', async () => {
  const { bundle, xdg, home } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', bundle, '--yes'])).code, 0);
  const term = termFor(xdg);
  const done = run([], term.runEnv({ cwd, home }));
  await term.waitFor(/What would you like to do/);
  assert.match(term.plain(), /ai-sdlc 1\.0\.0 installed/);
  await term.send('3');
  assert.strictEqual(await done, 0, term.stderrText());
  assert.match(term.plain(), /ai-sdlc doctor/);
  assert.match(term.plain(), /✔ manifest\s+payload 1\.0\.0/);
  assert.match(term.plain(), /Healthy/);
});

test('menu: Install starts the guided install', async () => {
  const { bundle, xdg, home } = setup();
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'app', '.git'), { recursive: true });
  const term = termFor(xdg);
  const done = run(['--root', root, '--from-bundle', bundle], term.runEnv({ cwd: root, home }));
  await term.waitFor(/What would you like to do/);
  await term.send('1');
  await term.waitFor(/Select the project to install into/);
  await term.send(KEYS.enter);
  await term.waitFor(/Review/);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.ok(exists(path.join(root, 'app'), '.claude/ai-sdlc.manifest.json'));
  assert.deepStrictEqual(term.stdin.rawCalls, [true, false, true, false], 'menu session and wizard session each restore the terminal');
});

