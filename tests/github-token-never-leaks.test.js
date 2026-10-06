'use strict';
// A recognisable fake token is placed in every supported credential source; after
// success and failure runs it must be absent from everything the CLI emits or writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { tmpDir, newProject, runCli, walk } = require('./helpers');
const { startMock, CANARY } = require('./github-mock');
const { makeTerm, KEYS } = require('./tui-helpers');
const { workspace, start } = require('./tui-wizard-helpers');

const filesUnder = (dir) => (fs.existsSync(dir) ? walk(dir) : []);
const leaks = (dirs, texts) => [
  ...texts.filter((t) => t.includes(CANARY)).map(() => 'output'),
  ...dirs.flatMap(filesUnder).filter((f) => fs.readFileSync(f).includes(CANARY)),
];

async function withMock(fn) {
  const mock = await startMock();
  try {
    await fn(mock);
  } finally {
    await mock.close();
  }
}

test('the token is absent from output, project files, manifest, journal, home and temp files (env source)', () => withMock(async (mock) => {
  const home = tmpDir();
  const project = newProject();
  const inj = { ...mock.inject(), home };
  const texts = [];
  const go = async (args, extra = inj) => {
    const r = await runCli(args, extra);
    texts.push(r.out, r.err);
    return r;
  };
  assert.strictEqual((await go(['install', '--project', project, '--dry-run'])).code, 0);
  assert.strictEqual((await go(['install', '--project', project, '--yes', '--json'])).code, 0);
  assert.strictEqual((await go(['update', '--project', project, '--yes'])).code, 0);
  assert.strictEqual((await go(['version', '--check', '--json', '--project', project])).code, 0);
  // Failure runs, including a server that echoes the token back.
  mock.hooks.push((req, res) => {
    if (req.url !== '/repos/acme/kit/releases/latest') return false;
    res.writeHead(500, { 'x-echo': CANARY }).end(CANARY);
    return true;
  });
  assert.strictEqual((await go(['update', '--project', project, '--yes'])).code, 1);
  assert.strictEqual((await go(['update', '--project', project, '--yes', '--json'])).code, 1);
  assert.deepStrictEqual(leaks([project, home, inj.tmp], texts), []);
}));

test('the token is absent when it comes from `gh auth token` or a git credential helper', () => withMock(async (mock) => {
  for (const answer of [{ gh: { code: 0, stdout: `${CANARY}\n` } }, { git: { code: 0, stdout: `username=x\npassword=${CANARY}\n` } }]) {
    const project = newProject();
    const inj = mock.asPublicApi({ runCommand: async (cmd) => answer[cmd] || { code: 1, stdout: '' } });
    const r = await runCli(['install', '--project', project, '--yes', '--json'], inj);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(mock.log.some((l) => l.auth === `Bearer ${CANARY}`), 'the discovered token authenticated the API calls');
    assert.deepStrictEqual(leaks([project, inj.tmp], [r.out, r.err]), []);
  }
}));

test('the wizard shows the token source, never the value, and keeps it out of recent.json', () => withMock(async (mock) => {
  const ws = workspace();
  const inj = mock.inject();
  const term = makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: ws.xdg, ...inj.env } });
  const done = start(term, ws, ['init', '--root', ws.root], { runCommand: inj.runCommand, releaseOptions: inj.releaseOptions });
  await term.waitFor(/Select the project to install into/);
  const intro = term.plain();
  assert.match(intro, /Kit source: GitHub release\s+acme\/kit via http:\/\/127\.0\.0\.1:\d+/);
  assert.match(intro, /GitHub token\s+found via AI_SDLC_GITHUB_TOKEN/);
  assert.match(intro, /Access to acme\/kit\s+read access confirmed/);
  assert.match(intro, /kit source: GitHub release \(custom API\) \| github token \| repo access/);
  await term.send('zeta', KEYS.enter);
  await term.waitFor(/Review/);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.ok(fs.existsSync(`${ws.repo('zeta-app')}/.claude/ai-sdlc.manifest.json`));
  assert.deepStrictEqual(leaks([ws.root, ws.xdg, inj.tmp], [term.raw(), term.stderrText()]), []);
  assert.deepStrictEqual(fs.readdirSync(inj.tmp), []);
}));

test('the wizard stops cleanly when the repository cannot be read, pointing at the owner and --from-bundle', () => withMock(async (mock) => {
  mock.hooks.push((req, res) => {
    if (req.url !== '/repos/acme/kit') return false;
    res.writeHead(404).end('{}');
    return true;
  });
  const ws = workspace();
  const inj = mock.inject();
  const term = makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: ws.xdg, ...inj.env } });
  const code = await start(term, ws, ['init', '--root', ws.root], { runCommand: inj.runCommand, releaseOptions: inj.releaseOptions });
  assert.strictEqual(code, 1);
  assert.match(term.plain(), /Access to acme\/kit\s+no read access to acme\/kit — ask the repo owner to grant read access/);
  assert.match(term.stderrText(), /grant read access: https:\/\/github\.com\/acme\/kit /);
  assert.match(term.stderrText(), /--from-bundle/);
  assert.deepStrictEqual(fs.readdirSync(ws.repo('zeta-app')), ['.git']);
  assert.strictEqual(term.stdin.listenerCount('data'), 0);
  assert.deepStrictEqual(leaks([ws.root, ws.xdg], [term.raw(), term.stderrText()]), []);
}));
