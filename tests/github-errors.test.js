'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { makeBundle, newProject, runCli, exists, sha } = require('./helpers');
const { startMock, CANARY } = require('./github-mock');

async function withMock(fn, opts) {
  const mock = await startMock(opts);
  try {
    await fn(mock);
  } finally {
    await mock.close();
  }
}

// Runs an install against the mock and checks the generic guarantees of a failed run.
async function failing(mock, extra = {}, args = []) {
  const project = newProject();
  const inj = mock.inject(extra);
  const r = await runCli(['install', '--project', project, '--yes', ...args], inj);
  assert.strictEqual(r.code, 1, r.err);
  assert.ok(!exists(project, '.claude'), 'nothing was installed');
  assert.deepStrictEqual(fs.readdirSync(inj.tmp), [], 'no temp files left');
  assert.doesNotMatch(r.err, /\n\s+at /, 'a message, not a stack trace');
  assert.ok(!r.err.includes(CANARY) && !r.out.includes(CANARY));
  return r;
}

const answer = (pattern, code, headers = {}, body = { message: `denied for ${CANARY}` }) => (req, res) => {
  if (!pattern.test(req.url)) return false;
  res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  return true;
};

test('401: the token is reported as invalid or expired, naming its source but not its value', () => withMock(async (mock) => {
  const r = await failing(mock, { env: { AI_SDLC_GITHUB_TOKEN: 'wrong-token-value' } });
  assert.match(r.err, /rejected the token from AI_SDLC_GITHUB_TOKEN \(invalid or expired\)/);
  assert.ok(!r.err.includes('wrong-token-value'));
}));

for (const code of [403, 404]) {
  test(`${code} on the repository: tells the user to ask the owner for read access`, () => withMock(async (mock) => {
    mock.hooks.push(answer(/^\/repos\/acme\/kit$/, code));
    const r = await failing(mock);
    assert.match(r.err, /no read access to acme\/kit — ask the repo owner to grant read access/);
    assert.match(r.err, /--from-bundle/);
  }));
}

test('rate limit: shows the reset time and does not retry', () => withMock(async (mock) => {
  const reset = Math.floor(Date.UTC(2031, 0, 2, 3, 4) / 1000);
  mock.hooks.push(answer(/^\/repos\/acme\/kit$/, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
  const r = await failing(mock);
  assert.match(r.err, /rate limit reached; resets at 2031-01-02 03:04 UTC/);
  assert.strictEqual(mock.log.filter((l) => l.url === '/repos/acme/kit').length, 1);
}));

test('429 with Retry-After says how long to wait', () => withMock(async (mock) => {
  mock.hooks.push(answer(/^\/repos\/acme\/kit$/, 429, { 'retry-after': '90' }));
  assert.match((await failing(mock)).err, /rate limit reached; try again in 90s/);
}));

test('a release that does not exist yet is not reported as missing access', () => withMock(async (mock) => {
  mock.releases = {};
  mock.hooks.push(answer(/\/releases\/latest$/, 404));
  assert.match((await failing(mock)).err, /no release has been published in acme\/kit/);
}));

test('5xx is retried twice and a later success wins', () => withMock(async (mock) => {
  let failures = 2;
  mock.hooks.push((req, res) => {
    if (req.url !== '/repos/acme/kit/releases/latest' || failures === 0) return false;
    failures -= 1;
    res.writeHead(503).end('busy');
    return true;
  });
  const project = newProject();
  const r = await runCli(['install', '--project', project, '--yes'], mock.inject());
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(mock.log.filter((l) => l.url.endsWith('/releases/latest')).length, 3);
}));

test('5xx that never recovers gives up after 3 attempts with a clear message', () => withMock(async (mock) => {
  mock.hooks.push(answer(/^\/repos\/acme\/kit$/, 502, {}, {}));
  const r = await failing(mock);
  assert.match(r.err, /GitHub is unavailable \(HTTP 502\)/);
  assert.strictEqual(mock.log.filter((l) => l.url === '/repos/acme/kit').length, 3);
}));

test('a hung server times out and the message suggests --from-bundle', () => withMock(async (mock) => {
  mock.hooks.push((req) => /^\/repos\/acme\/kit$/.test(req.url));
  const r = await failing(mock, { release: { timeoutMs: 150 } });
  assert.match(r.err, /timed out after 150ms/);
  assert.match(r.err, /--from-bundle/);
}));

test('nothing listening: reported as unreachable with a --from-bundle hint', async () => {
  const mock = await startMock();
  const inj = mock.inject();
  await mock.close();
  const r = await runCli(['install', '--project', newProject(), '--yes'], inj);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /cannot reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\); check your network, or install from a local file with --from-bundle/);
});

test('DNS failure from fetch is reported as unreachable and carries no token', async () => {
  const fetch = async () => {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error(`getaddrinfo ENOTFOUND api.github.com ${CANARY}`), { code: 'ENOTFOUND' });
    throw err;
  };
  const r = await runCli(['install', '--project', newProject(), '--yes'], {
    env: { AI_SDLC_GITHUB_TOKEN: CANARY }, runCommand: async () => ({ code: null, stdout: '' }), fetch, releaseOptions: { backoffMs: 1 },
  });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /cannot reach api\.github\.com \(ENOTFOUND\).*--from-bundle/);
  assert.ok(!r.err.includes(CANARY) && !r.out.includes(CANARY));
});

test('a release without a bundle asset, or without its checksum, is refused clearly', () => withMock(async (mock) => {
  mock.publish('2.0.0', makeBundle({ version: '2.0.0' }), { sidecar: false });
  assert.match((await failing(mock)).err, /no checksum asset \(ai-sdlc-2\.0\.0\.bundle\.json\.sha256\); refusing to install unverified/);
  mock.releases.v2 = { tag_name: 'v3.0.0', assets: [{ id: 99, name: 'notes.txt' }] };
  mock.latest = 'v2';
  assert.match((await failing(mock)).err, /has no bundle asset \(expected ai-sdlc-<version>\.bundle\.json\)/);
}));

test('a checksum that does not match the bundle is rejected before anything is written', () => withMock(async (mock) => {
  mock.publish('2.0.0', makeBundle({ version: '2.0.0' }));
  const sidecarId = Object.keys(mock.files).find((id) => mock.files[id].name === 'ai-sdlc-2.0.0.bundle.json.sha256');
  mock.files[sidecarId].body = `${sha(Buffer.from('something else'))}  ai-sdlc-2.0.0.bundle.json\n`;
  assert.match((await failing(mock)).err, /bundle checksum mismatch/);
}));

test('an asset that disappears between lookup and download is reported by name', () => withMock(async (mock) => {
  mock.hooks.push(answer(/\/releases\/assets\/\d+$/, 404));
  assert.match((await failing(mock)).err, /release asset ai-sdlc-1\.0\.0\.bundle\.json could not be downloaded/);
}));

test('a secret echoed back by the server never reaches the output', () => withMock(async (mock) => {
  mock.hooks.push(answer(/^\/repos\/acme\/kit$/, 500, {}, { message: `boom ${CANARY}` }));
  const r = await failing(mock, {}, ['--json']);
  assert.ok(!r.out.includes(CANARY));
}));
