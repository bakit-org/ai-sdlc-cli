'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveToken, redact, NO_TOKEN_MESSAGE, runCommand } = require('../lib/github-auth');
const { tmpDir } = require('./helpers');

// A fake process runner: answers per command name and records every call.
function fakeRun(answers = {}) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answers[cmd] || { code: null, stdout: '' };
  };
  return { run, calls };
}

test('env vars win, in the order AI_SDLC_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, and no program is started', async () => {
  const { run, calls } = fakeRun({ gh: { code: 0, stdout: 'from-gh\n' } });
  const all = { AI_SDLC_GITHUB_TOKEN: 'tok-a', GH_TOKEN: 'tok-b', GITHUB_TOKEN: 'tok-c' };
  assert.deepStrictEqual(await resolveToken({ env: all, runCommand: run }), { token: 'tok-a', source: 'AI_SDLC_GITHUB_TOKEN' });
  assert.deepStrictEqual(await resolveToken({ env: { GH_TOKEN: 'tok-b', GITHUB_TOKEN: 'tok-c' }, runCommand: run }), { token: 'tok-b', source: 'GH_TOKEN' });
  assert.deepStrictEqual(await resolveToken({ env: { GITHUB_TOKEN: ' tok-c ' }, runCommand: run }), { token: 'tok-c', source: 'GITHUB_TOKEN' });
  assert.deepStrictEqual(calls, []);
});

test('empty or malformed env values are skipped', async () => {
  const { run } = fakeRun({ gh: { code: 0, stdout: 'from-gh\n' } });
  const env = { AI_SDLC_GITHUB_TOKEN: '   ', GH_TOKEN: 'has space inside', GITHUB_TOKEN: 'line\nbreak' };
  assert.deepStrictEqual(await resolveToken({ env, runCommand: run }), { token: 'from-gh', source: 'gh auth login' });
});

test('next comes `gh auth token` for github.com, with prompts disabled', async () => {
  const { run, calls } = fakeRun({ gh: { code: 0, stdout: 'gho_fromgh\n' }, git: { code: 0, stdout: 'password=from-git\n' } });
  assert.deepStrictEqual(await resolveToken({ env: { PATH: '/bin' }, runCommand: run }), { token: 'gho_fromgh', source: 'gh auth login' });
  assert.deepStrictEqual(calls.map((c) => [c.cmd, ...c.args]), [['gh', 'auth', 'token', '--hostname', 'github.com']]);
  assert.strictEqual(calls[0].opts.env.GH_PROMPT_DISABLED, '1');
});

test('then `git credential fill` for github.com, never prompting', async () => {
  const { run, calls } = fakeRun({ gh: { code: 1, stdout: '' }, git: { code: 0, stdout: 'protocol=https\nhost=github.com\nusername=me\npassword=ghp_fromgit\n\n' } });
  assert.deepStrictEqual(await resolveToken({ env: {}, runCommand: run }), { token: 'ghp_fromgit', source: 'git credential helper' });
  const git = calls.find((c) => c.cmd === 'git');
  assert.deepStrictEqual(git.args, ['-c', 'core.askPass=', '-c', 'credential.interactive=false', 'credential', 'fill']);
  assert.strictEqual(git.opts.input, 'protocol=https\nhost=github.com\n\n');
  assert.strictEqual(git.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(git.opts.env.GIT_ASKPASS, '');
  assert.strictEqual(git.opts.env.SSH_ASKPASS, '');
});

test('nothing found: null, and the message names every way to provide credentials', async () => {
  const { run } = fakeRun({ gh: { code: 1, stdout: '' }, git: { code: 128, stdout: '' } });
  assert.strictEqual(await resolveToken({ env: {}, runCommand: run }), null);
  for (const hint of ['AI_SDLC_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'gh auth login', 'git credential helper', '--from-bundle']) {
    assert.ok(NO_TOKEN_MESSAGE.includes(hint), hint);
  }
});

test('a credential helper that answers without a password yields nothing', async () => {
  const { run } = fakeRun({ git: { code: 0, stdout: 'protocol=https\nhost=github.com\nusername=me\n' } });
  assert.strictEqual(await resolveToken({ env: {}, runCommand: run }), null);
});

test('redact removes the token and its URL-encoded form', () => {
  const token = 'tok/with+chars';
  const text = redact(`failed for ${token} and ${encodeURIComponent(token)}`, token);
  assert.ok(!text.includes(token) && !text.includes(encodeURIComponent(token)));
  assert.strictEqual(redact('plain', null), 'plain');
});

test('the real runner never rejects: a missing program, a failing one and a slow one all resolve with code null/non-zero', async () => {
  assert.strictEqual((await runCommand('ai-sdlc-no-such-program', [])).code, null);
  assert.notStrictEqual((await runCommand(process.execPath, ['-e', 'process.exit(3)'])).code, 0);
  const t0 = Date.now();
  assert.strictEqual((await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 150 })).code, null);
  assert.ok(Date.now() - t0 < 2000);
  const echoed = await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'password=x\n' });
  assert.strictEqual(echoed.stdout, 'password=x\n');
});

test('with explicitOnly only AI_SDLC_GITHUB_TOKEN counts and no program is started', async () => {
  const { run, calls } = fakeRun({ gh: { code: 0, stdout: 'from-gh\n' }, git: { code: 0, stdout: 'password=from-git\n' } });
  const others = { GH_TOKEN: 'tok-b', GITHUB_TOKEN: 'tok-c' };
  assert.strictEqual(await resolveToken({ env: others, runCommand: run, explicitOnly: true }), null);
  assert.deepStrictEqual(await resolveToken({ env: { ...others, AI_SDLC_GITHUB_TOKEN: 'tok-a' }, runCommand: run, explicitOnly: true }), { token: 'tok-a', source: 'AI_SDLC_GITHUB_TOKEN' });
  assert.deepStrictEqual(calls, []);
});

test('an aborted signal stops the lookup with its reason and kills a running child', async () => {
  const reason = new Error('stop');
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(resolveToken({ env: {}, runCommand: async () => ({ code: null, stdout: '' }), signal: controller.signal }), reason);
  const live = new AbortController();
  const t0 = Date.now();
  setTimeout(() => live.abort(), 100);
  const r = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { signal: live.signal });
  assert.strictEqual(r.code, null);
  assert.ok(Date.now() - t0 < 1500);
});

const hasGit = process.platform !== 'win32' && spawnSync('git', ['--version']).status === 0;

test('git credential fill never starts an askpass program, even when one is configured everywhere', { skip: !hasGit && 'git or a POSIX shell is not available' }, async () => {
  const dir = tmpDir();
  const log = path.join(dir, 'askpass.log');
  const script = path.join(dir, 'askpass.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho "$1" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, `[core]\n\taskPass = ${script}\n[credential]\n\thelper =\n`);
  const env = {
    PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: script, SSH_ASKPASS: script, DISPLAY: ':0',
  };
  // Control: plain git with this setup does call the askpass program (the test would be vacuous otherwise).
  spawnSync('git', ['credential', 'fill'], { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, input: 'protocol=https\nhost=github.com\n\n' });
  assert.ok(fs.existsSync(log), 'control run reached the askpass program');
  fs.rmSync(log);
  assert.strictEqual(await resolveToken({ env }), null);
  assert.ok(!fs.existsSync(log), 'the askpass program was not called');
});
