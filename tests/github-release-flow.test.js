'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeBundle, newProject, runCli, read, exists } = require('./helpers');
const { startMock, CANARY } = require('./github-mock');
const { createGithubClient } = require('../lib/github-release');

const bundleV2 = () => makeBundle({
  version: '1.1.0',
  files: [
    { path: '.claude/agents/alpha.md', class: 'managed', text: '# alpha v2\n' },
    { path: 'CLAUDE.md', class: 'block', text: '## router v2\n' },
  ],
});

async function withMock(fn, opts) {
  const mock = await startMock(opts);
  try {
    await fn(mock);
  } finally {
    await mock.close();
  }
}

test('install downloads the latest release from the API, sends the token only to the API origin, and removes the temp files', () => withMock(async (mock) => {
  const project = newProject();
  const inj = mock.inject();
  const r = await runCli(['install', '--project', project, '--yes'], inj);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# alpha v1\n');
  assert.ok(exists(project, '.claude/ai-sdlc.manifest.json'));

  const api = mock.log.filter((l) => l.host === 'api');
  assert.deepStrictEqual(api.map((l) => l.url.replace(/\d+$/, 'N')), [
    '/repos/acme/kit', '/repos/acme/kit/releases/latest', '/repos/acme/kit/releases/assets/N', '/repos/acme/kit/releases/assets/N',
  ]);
  assert.ok(api.every((l) => l.auth === `Bearer ${CANARY}`), 'every API request is authenticated');
  assert.strictEqual(api[2].accept, 'application/octet-stream', 'asset requests ask for the raw bytes');
  const storage = mock.log.filter((l) => l.host === 'assets');
  assert.strictEqual(storage.length, 2, 'both assets were fetched from the other origin after the redirect');
  assert.ok(storage.every((l) => l.auth === undefined), 'Authorization is not forwarded to the other origin');
  assert.deepStrictEqual(fs.readdirSync(inj.tmp), [], 'downloaded files are deleted afterwards');
}));

test('--json output of a download install has no token and still parses', () => withMock(async (mock) => {
  const project = newProject();
  const r = await runCli(['install', '--project', project, '--yes', '--json'], mock.inject());
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(JSON.parse(r.out).ok, true);
  assert.ok(!r.out.includes(CANARY) && !r.err.includes(CANARY));
}));

test('update fetches the newest release and applies it', () => withMock(async (mock) => {
  const project = newProject();
  assert.strictEqual((await runCli(['install', '--project', project, '--yes'], mock.inject())).code, 0);
  mock.publish('1.1.0', bundleV2());
  const r = await runCli(['update', '--project', project, '--yes'], mock.inject());
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# alpha v2\n');
  assert.match(read(project, '.claude/ai-sdlc.manifest.json'), /"payload_version": "1.1.0"/);
}));

test('--version pins a release (with or without the leading v); other tags are not touched', () => withMock(async (mock) => {
  mock.publish('1.1.0', bundleV2());
  for (const flag of ['1.0.0', 'v1.0.0']) {
    const project = newProject();
    const r = await runCli(['install', '--project', project, '--yes', '--version', flag], mock.inject());
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# alpha v1\n', `pinned ${flag}`);
  }
  assert.ok(mock.log.every((l) => !l.url.endsWith('/releases/latest')), 'the latest release is not consulted when pinned');
  const missing = await runCli(['install', '--project', newProject(), '--yes', '--version=9.9.9'], mock.inject());
  assert.strictEqual(missing.code, 1);
  assert.match(missing.err, /release 9\.9\.9 was not found in acme\/kit/);
}));

test('--version needs a sensible value and cannot be mixed with --from-bundle', async () => {
  const p = newProject();
  assert.strictEqual((await runCli(['install', '--project', p, '--yes', '--version'])).code, 2);
  const bad = await runCli(['install', '--project', p, '--yes', '--version', 'latest-ish'], { env: {}, runCommand: async () => ({ code: null, stdout: '' }) });
  assert.strictEqual(bad.code, 2);
  assert.match(bad.err, /--version must be a release version/);
  const both = await runCli(['install', '--project', p, '--yes', '--version', '1.0.0', '--from-bundle', 'x.json']);
  assert.strictEqual(both.code, 2);
});

test('--from-bundle never touches the network', () => withMock(async (mock) => {
  const { writeBundle } = require('./helpers');
  const file = writeBundle(tmpDir(), makeBundle());
  const r = await runCli(['install', '--project', newProject(), '--yes', '--from-bundle', file], mock.inject());
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(mock.log, []);
}));

test('a redirect to an insecure address is refused', () => withMock(async (mock) => {
  mock.hooks.push((req, res) => {
    if (!/\/releases\/assets\/\d+$/.test(req.url)) return false;
    res.writeHead(302, { location: 'http://example.com/blob' }).end();
    return true;
  });
  const inj = mock.inject();
  const r = await runCli(['install', '--project', newProject(), '--yes'], inj);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /unsafe address/);
  assert.deepStrictEqual(fs.readdirSync(inj.tmp), []);
}));

test('the downloaded bundle is private to the user while it exists', () => withMock(async (mock) => {
  const tmp = tmpDir();
  const client = createGithubClient({ env: mock.inject().env, runCommand: async () => ({ code: null, stdout: '' }), releaseOptions: { backoffMs: 1, tmpDir: tmp } });
  const dl = await client.downloadBundle();
  assert.strictEqual(dl.version, '1.0.0');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(dl.bundlePath).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(dl.bundlePath)).mode & 0o077, 0, 'directory is not group/world accessible');
  }
  dl.cleanup();
  assert.deepStrictEqual(fs.readdirSync(tmp), []);
}));

test('version --check compares the installed payload with the latest release', () => withMock(async (mock) => {
  const project = newProject();
  assert.strictEqual((await runCli(['install', '--project', project, '--yes'], mock.inject())).code, 0);
  mock.publish('1.1.0', bundleV2());
  const r = await runCli(['version', '--check', '--project', project], mock.inject());
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /latest payload release \(acme\/kit\): 1\.1\.0/);
  assert.match(r.out, /installed payload: 1\.0\.0 \(run `ai-sdlc update` to upgrade\)/);
  const j = JSON.parse((await runCli(['version', '--check', '--json', '--project', project], mock.inject())).out);
  assert.deepStrictEqual([j.latest, j.installed, j.status], ['1.1.0', '1.0.0', 'update-available']);
  assert.strictEqual((await runCli(['version'], mock.inject())).out.trim(), `ai-sdlc-cli ${require('../package.json').version}`);
}));
