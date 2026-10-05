'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeBundle, writeBundle, newProject, runCli, walk } = require('./helpers');

const snapshot = (dir) => Object.fromEntries(walk(dir).map((f) => [f, fs.readFileSync(f, 'utf8')]));

async function installed(extraFiles) {
  const project = newProject();
  const dir = tmpDir();
  const bundle = writeBundle(dir, makeBundle(extraFiles ? { files: extraFiles } : {}));
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', bundle, '--yes'])).code, 0);
  return { project, dir, bundle };
}

test('doctor on a healthy install passes and writes nothing', async () => {
  const { project, bundle } = await installed();
  const before = snapshot(project);
  const r = await runCli(['doctor', '--project', project, '--from-bundle', bundle]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /\[ok\]\s+node/);
  assert.match(r.out, /up to date \(1\.0\.0\)/);
  assert.deepStrictEqual(snapshot(project), before);
});

test('doctor flags modified (warn) and missing (fail) managed files', async () => {
  const { project } = await installed();
  fs.writeFileSync(path.join(project, '.claude/agents/alpha.md'), 'edited\n');
  let r = await runCli(['doctor', '--project', project]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /\[warn\] managed file: modified locally: \.claude\/agents\/alpha\.md/);
  fs.rmSync(path.join(project, '.claude/skills/beta/SKILL.md'));
  r = await runCli(['doctor', '--project', project]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /\[FAIL\] managed file: missing/);
});

test('doctor reports a missing CLAUDE.md block, missing scaffold and version drift', async () => {
  const { project, dir } = await installed();
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# nothing\n');
  fs.rmSync(path.join(project, 'ai-sdlc/project.md'));
  const newer = writeBundle(dir, makeBundle({ version: '2.0.0' }), { name: 'n.json' });
  const r = await runCli(['doctor', '--project', project, '--from-bundle', newer]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /router block missing/);
  assert.match(r.out, /\[warn\] scaffolds: missing: ai-sdlc\/project\.md/);
  assert.match(r.out, /installed 1\.0\.0, bundle 2\.0\.0/);
});

test('doctor on a project that is not installed fails; --json is parseable', async () => {
  const project = newProject();
  const r = await runCli(['doctor', '--project', project, '--json']);
  assert.strictEqual(r.code, 1);
  const parsed = JSON.parse(r.out);
  assert.strictEqual(parsed.ok, false);
  assert.ok(parsed.checks.some((c) => c.name === 'manifest' && c.status === 'fail'));
});

test('doctor notes optional Python only when python-needing scripts are installed', async () => {
  const plain = await installed();
  assert.doesNotMatch((await runCli(['doctor', '--project', plain.project])).out, /python/i);
  const withPy = await installed([
    { path: '.claude/skills/x/scripts/layout.py', class: 'managed', text: 'print(1)\n' },
    { path: 'CLAUDE.md', class: 'block', text: 'r\n' },
  ]);
  const r = await runCli(['doctor', '--project', withPy.project]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /\[warn\] python: optional/);
});
