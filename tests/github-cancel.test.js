'use strict';
// Ctrl-C / Esc during the environment check or the download, and SIGINT/SIGTERM in plain runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const { newProject, runCli } = require('./helpers');
const { startMock } = require('./github-mock');
const { makeTerm, KEYS, sleep } = require('./tui-helpers');
const { workspace, start, assertRestored, untouched } = require('./tui-wizard-helpers');
const { request } = require('../lib/github-http');

async function withMock(fn) {
  const mock = await startMock();
  try {
    await fn(mock);
  } finally {
    await mock.close();
  }
}

// Holds back the answer to matching requests for `ms` (the client is expected to hang up first).
const slow = (pattern, ms) => (req, res) => {
  if (!pattern.test(req.url)) return false;
  const timer = setTimeout(() => {
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  }, ms);
  timer.unref();
  return true;
};

function wizardTerm(ws, inj) {
  return makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: ws.xdg, ...inj.env } });
}

for (const [name, key, message] of [['Ctrl-C', KEYS.ctrlC, /interrupted; nothing was changed/], ['Esc', KEYS.esc, /cancelled; nothing was changed/]]) {
  test(`${name} during the environment check cancels the wizard at once, in-flight request included`, () => withMock(async (mock) => {
    mock.hooks.push(slow(/^\/repos\/acme\/kit$/, 3000));
    const ws = workspace();
    const inj = mock.inject();
    const term = wizardTerm(ws, inj);
    const done = start(term, ws, ['init', '--root', ws.root], { runCommand: inj.runCommand, releaseOptions: { ...inj.releaseOptions, timeoutMs: 10000 } });
    await term.waitFor(/Checking your environment/);
    await sleep(200);
    const t0 = Date.now();
    await term.send(key);
    assert.strictEqual(await done, 1);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    assert.match(term.stderrText(), message);
    untouched(ws);
    assertRestored(term);
    assert.deepStrictEqual(fs.readdirSync(inj.tmp), []);
  }));
}

test('Ctrl-C during the download stops it, removes the temp files and writes nothing', () => withMock(async (mock) => {
  mock.hooks.push(slow(/\/releases\/assets\/\d+$/, 3000));
  const ws = workspace();
  const inj = mock.inject();
  const term = wizardTerm(ws, inj);
  const done = start(term, ws, ['init', '--root', ws.root], { runCommand: inj.runCommand, releaseOptions: { ...inj.releaseOptions, timeoutMs: 10000 } });
  await term.waitFor(/Downloading the kit release/);
  const t0 = Date.now();
  await sleep(200);
  assert.strictEqual(fs.readdirSync(inj.tmp).length, 1, 'the private download directory exists while downloading');
  await term.send(KEYS.ctrlC);
  assert.strictEqual(await done, 1);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.deepStrictEqual(fs.readdirSync(inj.tmp), []);
  untouched(ws);
  assertRestored(term);
}));

test('an abort ends a request during its retry backoff instead of waiting it out', () => withMock(async (mock) => {
  mock.hooks.push((req, res) => {
    res.writeHead(503).end('busy');
    return true;
  });
  const controller = new AbortController();
  const reason = new Error('cancelled by test');
  setTimeout(() => controller.abort(reason), 150);
  const t0 = Date.now();
  await assert.rejects(request(`${mock.apiUrl}/repos/acme/kit`, { apiBase: mock.apiUrl, backoffMs: 5000, signal: controller.signal }), reason);
  assert.ok(Date.now() - t0 < 1000);
}));

test('SIGTERM while a plain run is downloading removes the temp directory and exits 143', () => withMock(async (mock) => {
  const proc = new EventEmitter();
  proc.exitCodes = [];
  proc.exit = (code) => proc.exitCodes.push(code);
  mock.hooks.push((req, res) => {
    if (!/\/releases\/assets\/\d+$/.test(req.url)) return false;
    setTimeout(() => res.writeHead(404).end('{}'), 400).unref();
    return true;
  });
  const inj = mock.inject();
  const running = runCli(['install', '--project', newProject(), '--yes'], { ...inj, proc });
  for (let i = 0; i < 100 && fs.readdirSync(inj.tmp).length === 0; i += 1) await sleep(10);
  assert.strictEqual(fs.readdirSync(inj.tmp).length, 1, 'download directory exists');
  assert.strictEqual(proc.listenerCount('SIGTERM'), 1);
  proc.emit('SIGTERM');
  assert.deepStrictEqual(proc.exitCodes, [143]);
  assert.deepStrictEqual(fs.readdirSync(inj.tmp), [], 'removed before exiting');
  await running;
  assert.strictEqual(proc.listenerCount('SIGTERM'), 0, 'handlers are removed afterwards');
  assert.strictEqual(proc.listenerCount('SIGINT'), 0);
}));

test('a finished plain run leaves no signal handlers and no temp directory behind', () => withMock(async (mock) => {
  const proc = new EventEmitter();
  proc.exit = () => assert.fail('must not exit');
  const inj = mock.inject();
  assert.strictEqual((await runCli(['install', '--project', newProject(), '--yes'], { ...inj, proc })).code, 0);
  assert.strictEqual(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM'), 0);
  assert.deepStrictEqual(fs.readdirSync(inj.tmp), []);
}));
