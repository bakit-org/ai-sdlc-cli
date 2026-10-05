'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { KEYS } = require('./tui-helpers');
const { workspace, termFor, start, assertRestored, untouched } = require('./tui-wizard-helpers');

test('Esc at the picker cancels: nothing written, exit 1, terminal restored', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
  assert.match(term.stderrText(), /cancelled; nothing was changed/);
  untouched(ws);
  assertRestored(term);
  assert.ok(!fs.existsSync(path.join(ws.xdg, 'ai-sdlc')), 'nothing remembered either');
});

test('Esc at the review goes back to the picker; a second Esc cancels with nothing written', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send('zeta', KEYS.enter);
  await term.waitFor(/Review/);
  await term.send(KEYS.esc);
  await term.waitFor(/Select the project to install into/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
  untouched(ws);
  assertRestored(term);
});

test('Ctrl-C at the review writes nothing and restores the terminal', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send('zeta', KEYS.enter);
  await term.waitFor(/Review/);
  await term.send(KEYS.ctrlC);
  assert.strictEqual(await done, 1);
  assert.match(term.stderrText(), /interrupted; nothing was changed/);
  untouched(ws);
  assertRestored(term);
});

test('Ctrl-C in the path field and closed input also leave the project alone', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send(KEYS.end, KEYS.enter);
  await term.waitFor(/Project path/);
  await term.send(KEYS.ctrlC);
  assert.strictEqual(await done, 1);
  untouched(ws);
  const eof = termFor(ws);
  const second = start(eof, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await eof.waitFor(/Select the project/);
  eof.stdin.end();
  assert.strictEqual(await second, 1);
  untouched(ws);
  assertRestored(eof);
});

test('--project skips the picker; Esc at the review then cancels instead of going back', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--project', ws.repo('zeta-app'), '--from-bundle', ws.bundle]);
  await term.waitFor(/Review/);
  assert.doesNotMatch(term.plain(), /Select the project/);
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
  untouched(ws);
});

