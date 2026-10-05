'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { run } = require('../lib/commands');
const { loadBundle } = require('../lib/bundle');
const { planSync } = require('../lib/plan');
const { acquireLock } = require('../lib/journal');
const { orderedChanges, beforeImages } = require('../lib/apply-plan');
const { writeAtomic, resolveInside } = require('../lib/fs-safe');
const { deadPid, tmpDir, makeBundle, writeBundle, newProject, runCli, read, exists } = require('./helpers');

const JOURNAL = '.claude/ai-sdlc.journal.json';
const HOOKS = [{ event: 'PostToolUse', matcher: 'Write', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sync.js"' }];
const hookBundle = () => makeBundle({
  hooks: HOOKS,
  files: [
    { path: '.claude/hooks/sync.js', class: 'managed', text: '// sync\n' },
    { path: 'CLAUDE.md', class: 'block', text: 'router\n' },
    { path: 'ai-sdlc/project.md', class: 'user-once', text: '# P\n' },
  ],
});

test('a second run is refused while the first holds the project lock', async () => {
  const project = newProject();
  const bundle = writeBundle(tmpDir(), makeBundle());
  // Run A sits at the confirmation prompt, holding the lock.
  const stdin = new PassThrough();
  const outA = [];
  const a = run(['install', '--project', project, '--from-bundle', bundle], {
    cwd: process.cwd(), isTTY: true, stdin, stdout: { write: (s) => outA.push(s) }, stderr: { write() {} }, home: tmpDir(),
  });
  for (let i = 0; i < 200 && !outA.join('').includes('Apply these changes?'); i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(outA.join('').includes('Apply these changes?'), 'run A reached the prompt');
  assert.ok(exists(project, JOURNAL));

  const b = await runCli(['install', '--project', project, '--from-bundle', bundle, '--yes', '--force']);
  assert.strictEqual(b.code, 1);
  assert.match(b.err, /in progress/);
  assert.ok(exists(project, JOURNAL), 'B did not remove A\'s journal');

  stdin.write('y\n');
  assert.strictEqual(await a, 0);
  assert.ok(!exists(project, JOURNAL));
  assert.ok(exists(project, '.claude/ai-sdlc.manifest.json'));
});

test('declining the prompt releases the lock and leaves no .claude behind', async () => {
  const project = newProject();
  const r = await runCli(['install', '--project', project, '--from-bundle', writeBundle(tmpDir(), makeBundle())], { isTTY: true, stdin: 'n\n' });
  assert.strictEqual(r.code, 1);
  assert.ok(!exists(project, '.claude'));
});

test('a journal owned by a live process is not recovered even with --force', async () => {
  const project = newProject();
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, JOURNAL), JSON.stringify({ op: 'install', pid: process.pid, entries: null }));
  const r = await runCli(['install', '--project', project, '--from-bundle', writeBundle(tmpDir(), makeBundle()), '--yes', '--force']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /in progress/);
  assert.ok(!exists(project, '.claude/agents'));
});

test('--force rolls an interrupted run back from the journal, and uninstall then restores the originals exactly', async () => {
  const claudeMd = '# Mine\r\nno trailing newline';
  const settings = '{\n\t"model": "x"\n}\n';
  const project = newProject({ 'CLAUDE.md': claudeMd, '.claude/settings.json': settings });
  const file = writeBundle(tmpDir(), hookBundle());

  // Simulate a crash: lock + before-images recorded, everything except the manifest written.
  const lock = acquireLock(project, 'install');
  const bundle = loadBundle({ bundlePath: file }, { cliVersion: '0.1.0' });
  const plan = planSync({ project, bundle, prior: null, force: false, cliVersion: '0.1.0', op: 'install' });
  const changes = orderedChanges(plan);
  lock.record(beforeImages(project, changes));
  for (const a of changes.slice(0, -1)) writeAtomic(resolveInside(project, a.path), a.write);
  const journal = JSON.parse(read(project, JOURNAL));
  fs.writeFileSync(path.join(project, JOURNAL), JSON.stringify({ ...journal, pid: deadPid() }));
  assert.match(read(project, 'CLAUDE.md'), /ai-sdlc:begin/);
  assert.match(read(project, '.claude/settings.json'), /PostToolUse/);

  const refused = await runCli(['install', '--project', project, '--from-bundle', file, '--yes']);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /--force/);

  const forced = await runCli(['install', '--project', project, '--from-bundle', file, '--yes', '--force']);
  assert.strictEqual(forced.code, 0, forced.err);
  assert.ok(!exists(project, JOURNAL));
  assert.strictEqual(JSON.parse(read(project, '.claude/ai-sdlc.manifest.json')).hooks.length, 1);

  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  assert.strictEqual(read(project, 'CLAUDE.md'), claudeMd);
  assert.strictEqual(read(project, '.claude/settings.json'), settings);
  assert.ok(!exists(project, '.claude/hooks'));
});

test('a corrupt or hostile journal is never replayed', async () => {
  const project = newProject();
  fs.mkdirSync(path.join(project, '.claude'));
  const evil = JSON.stringify({ op: 'install', pid: deadPid(), entries: [{ path: '../escape.txt', before: Buffer.from('x').toString('base64') }] });
  fs.writeFileSync(path.join(project, JOURNAL), evil);
  const r = await runCli(['install', '--project', project, '--from-bundle', writeBundle(tmpDir(), makeBundle()), '--yes', '--force']);
  assert.strictEqual(r.code, 1);
  assert.ok(!fs.existsSync(path.join(project, '..', 'escape.txt')));
});
