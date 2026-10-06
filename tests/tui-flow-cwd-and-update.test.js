'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/commands');
const { tmpDir, makeBundle, writeBundle, newProject, exists, read, runCli } = require('./helpers');
const { makeTerm, KEYS } = require('./tui-helpers');

const MANIFEST = '.claude/ai-sdlc.manifest.json';
const setup = () => ({ home: tmpDir(), xdg: tmpDir(), v1: writeBundle(tmpDir(), makeBundle()) });
const termFor = (xdg) => makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: xdg } });
const v2Files = [
  { path: '.claude/agents/alpha.md', class: 'managed', text: '# alpha v2\n' },
  { path: '.claude/skills/beta/SKILL.md', class: 'managed', text: '# beta v1\n' },
  { path: 'CLAUDE.md', class: 'block', text: '## ai-sdlc router\nUse the agents.\n' },
  { path: 'ai-sdlc/project.md', class: 'user-once', text: '# Project\n' },
];
const v2Bundle = () => writeBundle(tmpDir(), makeBundle({ version: '2.0.0', files: v2Files }));

test('init installs into the current folder with no project picker, even without .git', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = tmpDir('ai-sdlc-newfolder-');
  const term = termFor(xdg);
  const done = run(['init', '--from-bundle', v1], term.runEnv({ cwd, home }));
  await term.waitFor(/Review/);
  assert.doesNotMatch(term.plain(), /Select the project/);
  assert.match(term.plain(), /no \.git directory/);
  assert.ok(!exists(cwd, MANIFEST), 'nothing written while reviewing');
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.ok(exists(cwd, MANIFEST));
  assert.strictEqual(read(cwd, '.claude/agents/alpha.md'), '# alpha v1\n');
});

test('init in the home directory falls back to the picker and explains why', async () => {
  const { xdg, v1 } = setup();
  const home = tmpDir();
  const term = termFor(xdg);
  const done = run(['init', '--from-bundle', v1], term.runEnv({ cwd: home, home }));
  await term.waitFor(/Select the project to install into/);
  assert.match(term.plain(), /refusing to install into the home directory/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
  assert.match(term.stderrText(), /cancelled; nothing was changed/);
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test('init in a folder that is already installed ends with a pointer to update', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  const term = termFor(xdg);
  const code = await run(['init', '--from-bundle', v1], term.runEnv({ cwd, home }));
  assert.strictEqual(code, 1);
  assert.match(term.stderrText(), /already installed .*ai-sdlc update/);
});

test('update in the current folder: review shows old and new version, then the files change', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  const term = termFor(xdg);
  const done = run(['update', '--from-bundle', v2Bundle()], term.runEnv({ cwd, home }));
  await term.waitFor(/Review/);
  assert.match(term.screen(), /ai-sdlc 1\.0\.0 \S+ 2\.0\.0/);
  assert.match(term.screen(), /Enter update/);
  assert.strictEqual(read(cwd, '.claude/agents/alpha.md'), '# alpha v1\n', 'nothing written while reviewing');
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.match(term.plain(), /Updating ai-sdlc 2\.0\.0/);
  assert.match(term.plain(), /Updated/);
  assert.strictEqual(read(cwd, '.claude/agents/alpha.md'), '# alpha v2\n');
  assert.ok(!exists(cwd, '.claude/ai-sdlc.journal.json'), 'lock released');
  assert.deepStrictEqual(term.stdin.rawCalls, [true, false]);
});

test('update keeps a file the user edited and writes the new version next to it', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  fs.writeFileSync(path.join(cwd, '.claude/agents/alpha.md'), '# my edit\n');
  const term = termFor(xdg);
  const done = run(['update', '--from-bundle', v2Bundle()], term.runEnv({ cwd, home }));
  await term.waitFor(/Review/);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.strictEqual(read(cwd, '.claude/agents/alpha.md'), '# my edit\n');
  assert.strictEqual(read(cwd, '.claude/agents/alpha.md.new'), '# alpha v2\n');
  assert.match(term.plain(), /Review the \*\.new files/);
});

test('update with nothing to do says so and skips the review', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  const before = read(cwd, MANIFEST);
  const term = termFor(xdg);
  assert.strictEqual(await run(['update', '--from-bundle', v1], term.runEnv({ cwd, home })), 0, term.stderrText());
  assert.match(term.plain(), /Up to date/);
  assert.doesNotMatch(term.plain(), /Review/);
  assert.strictEqual(read(cwd, MANIFEST), before);
});

test('Esc at the update review cancels with nothing changed', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  const term = termFor(xdg);
  const done = run(['update', '--from-bundle', v2Bundle()], term.runEnv({ cwd, home }));
  await term.waitFor(/Review/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
  assert.match(term.stderrText(), /cancelled; nothing was changed/);
  assert.strictEqual(read(cwd, '.claude/agents/alpha.md'), '# alpha v1\n');
  assert.deepStrictEqual(term.stdin.rawCalls, [true, false]);
});

test('update --project on a folder without ai-sdlc points to init', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  const term = termFor(xdg);
  assert.strictEqual(await run(['update', '--project', cwd, '--from-bundle', v1], term.runEnv({ cwd, home })), 1);
  assert.match(term.stderrText(), /not installed in .*run "ai-sdlc init"/);
  assert.ok(!exists(cwd, '.claude'));
});

test('update from a folder without its own install (a subfolder of an installed repo) opens the picker, not a nested install', async () => {
  const { home, xdg, v1 } = setup();
  const repo = newProject();
  assert.strictEqual((await runCli(['install', '--project', repo, '--from-bundle', v1, '--yes'])).code, 0);
  const sub = path.join(repo, 'src');
  fs.mkdirSync(sub);
  const term = termFor(xdg);
  const done = run(['update', '--from-bundle', v1], term.runEnv({ cwd: sub, home }));
  await term.waitFor(/Select the project to update/);
  assert.match(term.plain(), /ai-sdlc is not installed in/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
  assert.ok(!exists(sub, '.claude'), 'no nested install');
});

test('update with an unreadable manifest reports it and does not suggest init', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject({ [MANIFEST]: '{ not json' });
  const term = termFor(xdg);
  assert.strictEqual(await run(['update', '--from-bundle', v1], term.runEnv({ cwd, home })), 1);
  assert.match(term.stderrText(), /manifest/i);
  assert.doesNotMatch(term.stderrText(), /ai-sdlc init/);
});

test('up to date with a leftover journal still says so and shows the warning', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  fs.writeFileSync(path.join(cwd, '.claude/ai-sdlc.journal.json'), '{}');
  const term = termFor(xdg);
  assert.strictEqual(await run(['update', '--from-bundle', v1], term.runEnv({ cwd, home })), 0, term.stderrText());
  assert.match(term.plain(), /Up to date/);
  assert.match(term.plain(), /journal\.json exists/);
});

test('an older release than the installed one is flagged on the review screen', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v2Bundle(), '--yes'])).code, 0);
  const term = termFor(xdg);
  const done = run(['update', '--from-bundle', v1], term.runEnv({ cwd, home }));
  await term.waitFor(/Review/);
  assert.match(term.screen(), /older than the installed one/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
});

test('plain uninstall with --root does not silently act on an installed current folder', async () => {
  const { home, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'other', '.git'), { recursive: true });
  const r = await runCli(['uninstall', '--no-tui', '--root', root], { cwd, home, isTTY: true, stdin: 'q\n' });
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /Select the project/);
  assert.ok(exists(cwd, MANIFEST), 'the current folder was not touched');
});

test('the menu offers Update and runs the guided update for the current folder', async () => {
  const { home, xdg, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  const term = termFor(xdg);
  const done = run(['--from-bundle', v2Bundle()], term.runEnv({ cwd, home }));
  await term.waitFor(/What would you like to do/);
  await term.send('2');
  await term.waitFor(/Review/);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.strictEqual(read(cwd, '.claude/agents/alpha.md'), '# alpha v2\n');
});

test('plain update (--no-tui) uses the current folder when ai-sdlc is installed there', async () => {
  const { home, v1 } = setup();
  const cwd = newProject();
  assert.strictEqual((await runCli(['install', '--project', cwd, '--from-bundle', v1, '--yes'])).code, 0);
  const r = await runCli(['update', '--no-tui', '--from-bundle', v2Bundle()], { cwd, home, isTTY: true, stdin: 'y\n' });
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(cwd, '.claude/agents/alpha.md'), '# alpha v2\n');
});
