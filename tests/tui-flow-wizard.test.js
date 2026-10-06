'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { exists, read, runCli, NO_CREDENTIALS } = require('./helpers');
const { KEYS } = require('./tui-helpers');
const { MANIFEST, workspace, termFor, start, assertRestored, untouched } = require('./tui-wizard-helpers');

test('wizard happy path: banner, status line, picker, review, progress, result; files are installed', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);

  await term.waitFor(/Select the project to install into/);
  const intro = term.plain();
  assert.match(intro, /> AI-SDLC/, 'one-line banner without colour support');
  assert.match(intro, /Using: node \d+ \| git . \| kit source: bundle file/);
  assert.match(intro, /Node\.js\s+v\d+/);
  assert.match(intro, /git\s+2\.40\.0/);
  assert.match(intro, /Kit source: bundle file\s+ai-sdlc-test\.bundle\.json/);
  const pick = term.screen();
  assert.match(pick, /zeta-app\s+.*not installed/);
  assert.match(pick, /other-repo/);
  assert.match(pick, /Enter a path/);
  assert.match(pick, /╭─+╮/);

  await term.send('zeta');
  assert.doesNotMatch(term.screen(), /other-repo/);
  await term.send(KEYS.enter);
  await term.waitFor(/Review/);
  const review = term.screen();
  assert.match(review, /managed\s+2 files\s+create 2/);
  assert.match(review, /user-once\s+1 starter file\s+create 1/);
  assert.match(review, /block\s+CLAUDE\.md block\s+create/);
  assert.match(review, /only the marked ai-sdlc block is managed/);
  assert.doesNotMatch(review, /\.claude\/agents\/alpha\.md/, 'full list is collapsed by default');
  await term.send('d');
  assert.match(term.screen(), /\.claude\/agents\/alpha\.md/);
  await term.send('d');
  assert.ok(!exists(ws.repo('zeta-app'), '.claude'), 'nothing is written while reviewing');

  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  const out = term.plain();
  assert.match(out, /Installing ai-sdlc 1\.0\.0/);
  assert.match(out, /100%/);
  assert.match(out, /Installed/);
  assert.match(out, /Open this folder in Claude Code/);
  assert.match(out, /Fill in ai-sdlc\/project\.md/);
  assert.match(out, /ai-sdlc doctor/);
  const project = ws.repo('zeta-app');
  assert.ok(exists(project, MANIFEST));
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# alpha v1\n');
  assert.ok(exists(project, 'ai-sdlc/project.md'));
  assert.match(read(project, 'CLAUDE.md'), /ai-sdlc:begin/);
  assert.ok(!exists(project, '.claude/ai-sdlc.journal.json'), 'lock released');
  assertRestored(term);

  const recent = JSON.parse(read(ws.xdg, 'ai-sdlc/recent.json'));
  assert.deepStrictEqual(Object.keys(recent), ['projects']);
  assert.deepStrictEqual(recent.projects, [project]);
  const doc = await runCli(['doctor', '--project', project, '--from-bundle', ws.bundle]);
  assert.strictEqual(doc.code, 0, doc.out);
});

test('Windows-style CRLF Enter works through the whole wizard', async () => {
  const ws = workspace(['zeta-app']);
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send('\r\n');
  await term.waitFor(/Review/);
  await term.send('\r\n');
  assert.strictEqual(await done, 0, term.stderrText());
  assert.ok(exists(ws.repo('zeta-app'), MANIFEST));
});

test('resize while picking redraws the box at the new width', async () => {
  const ws = workspace();
  const term = termFor(ws, { columns: 90 });
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  const border = () => term.screen().split('\n').find((l) => l.startsWith('╭')).length;
  assert.strictEqual(border(), 89);
  term.stdout.columns = 60;
  term.stdout.emit('resize');
  assert.strictEqual(border(), 59);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
});

test('without --from-bundle and without credentials the preflight shows the failed token check and the run exits 1', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const code = await start(term, ws, ['init', '--root', ws.root], { runCommand: NO_CREDENTIALS.runCommand });
  assert.strictEqual(code, 1);
  assert.match(term.plain(), /Kit source: GitHub release/);
  assert.match(term.plain(), /GitHub token\s+not found: set AI_SDLC_GITHUB_TOKEN/);
  assert.match(term.stderrText(), /GitHub token: not found/);
  assert.match(term.stderrText(), /--from-bundle/);
  untouched(ws);
  assertRestored(term);
});

test('a missing bundle file is a failed preflight item and a normal error', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const code = await start(term, ws, ['init', '--root', ws.root, '--from-bundle', path.join(ws.root, 'missing.json')]);
  assert.strictEqual(code, 1);
  assert.match(term.plain(), /Kit source: bundle file\s+not found: /);
  assert.match(term.stderrText(), /cannot read bundle/);
  assertRestored(term);
});

test('an already installed project is offered with its version; choosing it explains and returns to the list', async () => {
  const ws = workspace(['zeta-app', 'other-repo']);
  assert.strictEqual((await runCli(['install', '--project', ws.repo('zeta-app'), '--from-bundle', ws.bundle, '--yes'])).code, 0);
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  assert.match(term.screen(), /installed v1\.0\.0 → update/);
  await term.send('zeta', KEYS.enter);
  await term.waitFor(/already installed \(payload 1\.0\.0\); use "ai-sdlc update"/);
  assert.match(term.screen(), /Select the project to install into/, 'back on the list, not out of the program');
  await term.send(KEYS.ctrlU, 'other', KEYS.enter);
  await term.waitFor(/Review/);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.ok(exists(ws.repo('other-repo'), MANIFEST));
  assertRestored(term);
});

test('--project pointing at an installed project still fails with the plain message', async () => {
  const ws = workspace(['zeta-app']);
  assert.strictEqual((await runCli(['install', '--project', ws.repo('zeta-app'), '--from-bundle', ws.bundle, '--yes'])).code, 0);
  const term = termFor(ws);
  assert.strictEqual(await start(term, ws, ['init', '--project', ws.repo('zeta-app'), '--from-bundle', ws.bundle]), 1);
  assert.match(term.stderrText(), /already installed \(payload 1\.0\.0\)/);
  assertRestored(term);
});

test('a planning error (a directory where a file belongs) is shown as a notice on the list', async () => {
  const ws = workspace(['zeta-app']);
  const project = ws.repo('zeta-app');
  fs.mkdirSync(path.join(project, '.claude', 'agents', 'alpha.md'), { recursive: true });
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send(KEYS.enter);
  await term.waitFor(/⚠ .+/);
  assert.match(term.screen(), /Select the project to install into/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
  assert.ok(!exists(project, MANIFEST));
  assertRestored(term);
});

const canChmod = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
test('a write failure after the confirmation leaves no manifest and the terminal restored', { skip: !canChmod && 'needs a non-root POSIX user' }, async () => {
  const ws = workspace(['zeta-app']);
  const project = ws.repo('zeta-app');
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send(KEYS.enter);
  await term.waitFor(/Review/);
  fs.chmodSync(project, 0o555);
  try {
    await term.send(KEYS.enter);
    assert.notStrictEqual(await done, 0);
  } finally {
    fs.chmodSync(project, 0o755);
  }
  assert.ok(!exists(project, MANIFEST));
  assert.ok(!exists(project, 'CLAUDE.md'));
  assertRestored(term);
});
