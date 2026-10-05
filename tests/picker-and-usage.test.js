'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { tmpDir, makeBundle, writeBundle, newProject, runCli, exists } = require('./helpers');
const { createPrompter, pickProject, findRepos } = require('../lib/project-picker');

const sink = () => {
  const chunks = [];
  return { write: (s) => chunks.push(String(s)), text: () => chunks.join('') };
};

function scripted(lines) {
  const input = new PassThrough();
  input.end(lines.join('\n') + '\n');
  return createPrompter({ input, output: sink() });
}

test('--project wins and no prompting happens', async () => {
  const project = newProject();
  const out = sink();
  const r = await pickProject({ project, cwd: tmpDir(), home: tmpDir(), prompter: null, output: out });
  assert.strictEqual(r.dir, fs.realpathSync(project));
  assert.strictEqual(r.hasGit, true);
});

test('target without .git is accepted with a warning', async () => {
  const dir = tmpDir();
  const out = sink();
  const r = await pickProject({ project: dir, cwd: tmpDir(), home: tmpDir(), prompter: null, output: out });
  assert.strictEqual(r.hasGit, false);
  assert.match(out.text(), /no \.git/);
});

test('scripted stdin picks a repository from the list under --root', async () => {
  const root = tmpDir();
  for (const n of ['alpha', 'beta']) fs.mkdirSync(path.join(root, n, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plain'));
  const out = sink();
  const prompter = scripted(['2']);
  const r = await pickProject({ root, cwd: tmpDir(), home: tmpDir(), prompter, output: out });
  prompter.close();
  assert.strictEqual(r.dir, path.join(root, 'beta'));
  assert.match(out.text(), /1\) .*alpha/);
  assert.doesNotMatch(out.text(), /plain/);
});

test('scripted stdin can enter a path instead', async () => {
  const project = newProject();
  const prompter = scripted(['p', project]);
  const r = await pickProject({ root: tmpDir(), cwd: tmpDir(), home: tmpDir(), prompter, output: sink() });
  prompter.close();
  assert.strictEqual(r.dir, fs.realpathSync(project));
});

test('without --root the picker scans cwd, then its parent', () => {
  const parent = tmpDir();
  const cwd = path.join(parent, 'work');
  fs.mkdirSync(path.join(cwd, 'inner', '.git'), { recursive: true });
  fs.mkdirSync(path.join(parent, 'sibling', '.git'), { recursive: true });
  assert.deepStrictEqual(findRepos([cwd, parent]), [path.join(cwd, 'inner'), path.join(parent, 'sibling')]);
});

test('cancelling or running out of input fails without changes', async () => {
  const prompter = scripted(['q']);
  await assert.rejects(pickProject({ root: tmpDir(), cwd: tmpDir(), home: tmpDir(), prompter, output: sink() }), /cancelled/);
  prompter.close();
});

test('refuses ~, a file, a missing path and a filesystem root', async () => {
  const home = tmpDir();
  const file = path.join(tmpDir(), 'f.txt');
  fs.writeFileSync(file, 'x');
  const opts = { cwd: tmpDir(), home, prompter: null, output: sink() };
  for (const project of ['~', home, file, path.join(home, 'nope'), path.parse(os.tmpdir()).root]) {
    await assert.rejects(pickProject({ ...opts, project }), (e) => e.exitCode === 2, project);
  }
});

test('end to end: interactive pick, plan shown, confirmed with y', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'app', '.git'), { recursive: true });
  const bundle = writeBundle(tmpDir(), makeBundle());
  const r = await runCli(['install', '--root', root, '--from-bundle', bundle], { isTTY: true, stdin: '1\ny\n' });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /create\s+\.claude\/agents\/alpha\.md/);
  assert.ok(exists(path.join(root, 'app'), '.claude/ai-sdlc.manifest.json'));
});

test('end to end: answering n at the confirmation changes nothing', async () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'app', '.git'), { recursive: true });
  const r = await runCli(['install', '--root', root, '--from-bundle', writeBundle(tmpDir(), makeBundle())], { isTTY: true, stdin: '1\nn\n' });
  assert.strictEqual(r.code, 1);
  assert.ok(!exists(path.join(root, 'app'), '.claude'));
});

test('non-interactive runs need --project and --yes, otherwise exit 2', async () => {
  const project = newProject();
  const bundle = writeBundle(tmpDir(), makeBundle());
  assert.strictEqual((await runCli(['install', '--from-bundle', bundle, '--yes'])).code, 2);
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', bundle])).code, 2);
  assert.strictEqual((await runCli(['uninstall', '--project', project])).code, 2);
  assert.strictEqual((await runCli(['doctor'])).code, 2);
  assert.ok(!exists(project, '.claude'));
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', bundle, '--dry-run'])).code, 0);
});

test('install/update without --from-bundle explain that download is not implemented (exit 2)', async () => {
  const project = newProject();
  for (const cmd of ['install', 'update']) {
    const r = await runCli([cmd, '--project', project, '--yes']);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /not implemented yet; use --from-bundle/);
  }
});

test('usage errors exit 2: unknown command, unknown flag, missing value, stray argument', async () => {
  for (const args of [['frobnicate'], ['install', '--nope'], ['install', '--project'], ['install', 'extra'], []]) {
    assert.strictEqual((await runCli(args)).code, 2, args.join(' '));
  }
});

test('version and help exit 0', async () => {
  const v = await runCli(['version']);
  assert.strictEqual(v.code, 0);
  assert.match(v.out, /ai-sdlc-cli \d+\.\d+\.\d+/);
  assert.strictEqual((await runCli(['--version'])).code, 0);
  assert.match((await runCli(['--help'])).out, /Usage: ai-sdlc/);
});

test('refuses the home directory through the CLI', async () => {
  const home = tmpDir();
  const bundle = writeBundle(tmpDir(), makeBundle());
  const out = [];
  const { run } = require('../lib/commands');
  const code = await run(['install', '--project', '~', '--from-bundle', bundle, '--yes'], { cwd: home, home, isTTY: false, stdout: { write() {} }, stderr: { write: (s) => out.push(s) } });
  assert.strictEqual(code, 2);
  assert.match(out.join(''), /home directory/);
  assert.ok(!exists(home, '.claude'));
});
