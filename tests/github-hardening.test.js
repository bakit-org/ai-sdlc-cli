'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { makeBundle, newProject, runCli, exists } = require('./helpers');
const { startMock, CANARY } = require('./github-mock');
const { makeTerm } = require('./tui-helpers');
const { workspace, start } = require('./tui-wizard-helpers');
const { isAllowedUrl } = require('../lib/config');
const { githubChecks } = require('../lib/github-checks');
const { CliError } = require('../lib/errors');

async function withMock(fn) {
  const mock = await startMock();
  try {
    await fn(mock);
  } finally {
    await mock.close();
  }
}

const reply = (pattern, code, headers = {}) => (req, res) => {
  if (!pattern.test(req.url)) return false;
  res.writeHead(code, { 'content-type': 'application/json', ...headers }).end('{}');
  return true;
};

test('a non-default API base never receives tokens found in GH_TOKEN, GITHUB_TOKEN, gh or the git credential helper', () => withMock(async (mock) => {
  const started = [];
  const inj = mock.inject({
    env: { AI_SDLC_GITHUB_TOKEN: '', GH_TOKEN: CANARY, GITHUB_TOKEN: CANARY },
    runCommand: async (cmd) => {
      started.push(cmd);
      return { code: 0, stdout: `password=${CANARY}\n${CANARY}\n` };
    },
  });
  const project = newProject();
  const r = await runCli(['install', '--project', project, '--yes'], inj);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /no credentials for the API at http:\/\/127\.0\.0\.1:\d+: set AI_SDLC_GITHUB_TOKEN/);
  assert.deepStrictEqual(mock.log, [], 'no request reached the host');
  assert.deepStrictEqual(started, [], 'gh and git were not even started');
  assert.ok(!exists(project, '.claude'));
  assert.ok(!r.err.includes(CANARY));
}));

test('the public API base still accepts GH_TOKEN and GITHUB_TOKEN', () => withMock(async (mock) => {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const r = await runCli(['install', '--project', newProject(), '--yes'], mock.asPublicApi({ env: { [name]: CANARY } }));
    assert.strictEqual(r.code, 0, r.err);
  }
}));

test('the wizard shows a custom API base and explains that an explicit token is needed', () => withMock(async (mock) => {
  const ws = workspace();
  const inj = mock.inject({ env: { AI_SDLC_GITHUB_TOKEN: '', GH_TOKEN: CANARY } });
  const term = makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: ws.xdg, ...inj.env } });
  const code = await start(term, ws, ['init', '--root', ws.root], { runCommand: inj.runCommand, releaseOptions: inj.releaseOptions });
  assert.strictEqual(code, 1);
  assert.match(term.plain(), /Kit source: GitHub release\s+acme\/kit via http:\/\/127\.0\.0\.1:\d+/);
  assert.match(term.plain(), /GitHub token\s+not found: http:\/\/127\.0\.0\.1:\d+ needs AI_SDLC_GITHUB_TOKEN/);
  assert.deepStrictEqual(mock.log, []);
}));

test('redirect targets with embedded credentials are refused', () => withMock(async (mock) => {
  mock.hooks.push((req, res) => {
    if (!/\/releases\/assets\/\d+$/.test(req.url)) return false;
    res.writeHead(302, { location: 'https://user:hunter2@example.com/blob' }).end();
    return true;
  });
  const r = await runCli(['install', '--project', newProject(), '--yes'], mock.inject());
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /unsafe address \(https:\/\/example\.com\)/);
  assert.ok(!r.err.includes('hunter2'));
  const base = 'https://api.github.com';
  assert.strictEqual(isAllowedUrl(new URL('https://u:p@example.com/x'), base), false);
  assert.strictEqual(isAllowedUrl(new URL('https://u@example.com/x'), base), false);
  assert.strictEqual(isAllowedUrl(new URL('https://example.com/x'), base), true);
}));

test('a bundle whose payload version differs from its release tag is refused', () => withMock(async (mock) => {
  mock.publish('2.0.0', makeBundle({ version: '1.0.0' }));
  const project = newProject();
  const r = await runCli(['install', '--project', project, '--yes'], mock.inject());
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /tagged 2\.0\.0 but its bundle contains payload 1\.0\.0/);
  assert.ok(!exists(project, '.claude'));
  const pinned = await runCli(['install', '--project', project, '--yes', '--version', '2.0.0'], mock.inject());
  assert.match(pinned.err, /tagged 2\.0\.0 but its bundle contains payload 1\.0\.0/);
}));

test('403 with an SSO header tells the user to authorize the token for SSO', () => withMock(async (mock) => {
  mock.hooks.push(reply(/^\/repos\/acme\/kit$/, 403, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=abc' }));
  const r = await runCli(['install', '--project', newProject(), '--yes'], mock.inject());
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /SAML single sign-on: authorize the token for the organization/);
  assert.doesNotMatch(r.err, /authorization_request/);
}));

test('the access failure detail names --from-bundle exactly once', async () => {
  const noAccess = new CliError('no read access to acme/kit — ask the repo owner to grant read access (or install from a local file with --from-bundle <file>)');
  const client = { describe: async () => ({ repo: 'acme/kit', source: 'GH_TOKEN', defaultBase: true }), checkAccess: async () => { throw noAccess; } };
  const [, access] = githubChecks(client);
  assert.strictEqual((await access()).detail.split('--from-bundle').length - 1, 1);
  client.checkAccess = async () => { throw new CliError('GitHub rejected the token'); };
  assert.strictEqual((await access()).detail.split('--from-bundle').length - 1, 1);
});

test('flag combinations are validated before any network or wizard work', () => withMock(async (mock) => {
  const project = newProject();
  for (const args of [
    ['doctor', '--project', project, '--version', '1.0.0'],
    ['uninstall', '--project', project, '--version', '1.0.0', '--yes'],
    ['install', '--project', project, '--yes', '--check'],
    ['update', '--project', project, '--yes', '--version', 'not-a-version'],
    ['install', '--project', project, '--yes', '--version', '1.0.0', '--from-bundle', 'x.json'],
  ]) {
    const r = await runCli(args, mock.inject());
    assert.strictEqual(r.code, 2, args.join(' '));
  }
  assert.strictEqual((await runCli(['--check'], mock.inject())).code, 2);
  assert.deepStrictEqual(mock.log, [], 'nothing was requested');
  const ws = workspace();
  const term = makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: ws.xdg } });
  const code = await start(term, ws, ['init', '--root', ws.root, '--version', 'bogus']);
  assert.strictEqual(code, 2);
  assert.doesNotMatch(term.plain(), /Checking your environment/);
  assert.deepStrictEqual(fs.readdirSync(ws.repo('zeta-app')), ['.git']);
}));
