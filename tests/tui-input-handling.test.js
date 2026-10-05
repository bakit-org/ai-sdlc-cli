'use strict';
// Typed-ahead keys, split escape sequences, runaway pastes, closed input, plan drift.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createKeyParser, MAX_PASTE } = require('../lib/tui/keys');
const { createConfirm } = require('../lib/tui/widgets/confirm');
const { exists, read } = require('./helpers');
const { KEYS, sleep } = require('./tui-helpers');
const { workspace, termFor, start, assertRestored, untouched, MANIFEST } = require('./tui-wizard-helpers');
const { drive } = require('./tui-widget-drive');

function collect(options) {
  const out = [];
  const parser = createKeyParser((k) => out.push(k), options);
  return { out, parser, names: () => out.map((k) => (k.name === 'char' ? k.text : k.ctrl ? `ctrl-${k.name}` : k.name)) };
}

test('Enter pressed twice at once does not skip the review', async () => {
  const ws = workspace(['zeta-app']);
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  term.stdin.write('zeta\r\r\r');
  await term.waitFor(/Review/);
  await sleep(60);
  assert.match(term.screen(), /Review/, 'still waiting for a deliberate answer');
  untouched(ws);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.ok(exists(ws.repo('zeta-app'), MANIFEST));
});

test('keys typed while the environment check runs never reach the picker', async () => {
  const ws = workspace(['zeta-app']);
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  term.stdin.write('\r\r');
  await term.waitFor(/Select the project/);
  await sleep(40);
  assert.match(term.screen(), /Select the project/, 'the Enter typed during the spinner was dropped');
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
  untouched(ws);
});

test('the review ignores Enter and y that arrive right after it appears, then accepts them', async () => {
  const ws = workspace(['zeta-app']);
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle], { confirmGuardMs: 150 });
  await term.waitFor(/Select the project/);
  await term.send(KEYS.enter);
  await term.waitFor(/Review/);
  await term.send(KEYS.enter, 'y');
  assert.match(term.screen(), /Review/);
  untouched(ws);
  await sleep(200);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
});

test('confirm widget: the guard only affects Enter and y, and only while the screen is new', () => {
  const body = () => ['x'];
  const c = () => createConfirm({ title: 'T', body, guardMs: 150 });
  const at = (elapsed) => ({ theme: undefined, width: 80, rows: 30, elapsed });
  const press = (keys, elapsed) => {
    const s = c();
    return drive(s, keys, { ...at(elapsed), theme: require('../lib/tui/theme').createTheme({ level: 0, unicode: true, attrs: false }) }).done;
  };
  assert.strictEqual(press('\r', 10), undefined);
  assert.strictEqual(press('y', 10), undefined);
  assert.strictEqual(press('\r', 200), true);
  assert.strictEqual(press('\r', undefined), true);
  assert.notStrictEqual(press('\x1b', 10), undefined, 'Esc and n always work');
  assert.notStrictEqual(press('n', 10), undefined);
});

test('input that ends before the first screen cancels the run (exit 1), not a silent exit 0', async () => {
  for (const how of ['end', 'destroy']) {
    const ws = workspace(['zeta-app']);
    const term = termFor(ws);
    const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
    if (how === 'end') term.stdin.end();
    else term.stdin.destroy();
    assert.strictEqual(await done, 1, how);
    assert.match(term.stderrText(), /cancelled; nothing was changed/);
    untouched(ws);
    assertRestored(term);
  }
});

test('an Escape sequence split across reads is still an arrow; a real Esc is reported after a short wait', async () => {
  const split = collect({ escapeMs: 30 });
  split.parser.feed('\x1b');
  split.parser.feed('[B');
  split.parser.feed('\x1b[');
  split.parser.feed('A');
  assert.deepStrictEqual(split.names(), ['down', 'up']);
  const lone = collect({ escapeMs: 20 });
  lone.parser.feed('\x1b');
  assert.deepStrictEqual(lone.names(), [], 'held, not reported yet');
  await sleep(60);
  assert.deepStrictEqual(lone.names(), ['escape']);
  const bare = collect({ escapeMs: 20 });
  bare.parser.feed('\x1b[');
  await sleep(60);
  assert.deepStrictEqual(bare.names(), ['escape', '['], 'a bare ESC [ that never completes is Escape plus the character');
  const doubled = collect({ escapeMs: 20 });
  doubled.parser.feed('\x1b\x1b');
  await sleep(60);
  assert.deepStrictEqual(doubled.names(), ['escape', 'escape']);
  assert.deepStrictEqual(collect({ escapeMs: 0 }).parser.feed('\x1b') ?? 'immediate', 'immediate');
});

test('Escape split across reads works through a whole session', async () => {
  const ws = workspace(['zeta-app']);
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  term.stdin.write('\x1b');
  await sleep(2);
  term.stdin.write('[A');
  await sleep(40);
  assert.match(term.screen(), /Select the project/, 'an arrow, not an Escape that cancels');
  await term.send(KEYS.esc);
  assert.strictEqual(await done, 1);
});

test('an unterminated paste cannot swallow Ctrl-C, and runaway pastes are capped', async () => {
  const a = collect();
  a.parser.feed('\x1b[200~abc');
  a.parser.feed('more text');
  a.parser.feed('\x03');
  assert.deepStrictEqual(a.names(), ['ctrl-c']);
  a.parser.feed('x');
  assert.deepStrictEqual(a.names(), ['ctrl-c', 'x'], 'normal input resumes');

  const big = collect();
  big.parser.feed('\x1b[200~');
  const block = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 24; i += 1) big.parser.feed(block);
  assert.strictEqual(big.out.length, 1);
  assert.strictEqual(big.out[0].name, 'paste');
  assert.strictEqual(big.out[0].text.length, MAX_PASTE);
  big.parser.feed('\x03');
  assert.deepStrictEqual(big.names(), ['paste', 'ctrl-c']);

  const done = collect();
  done.parser.feed(`\x1b[200~${'y'.repeat(MAX_PASTE + 10)}\x1b[201~z`);
  assert.deepStrictEqual(done.names(), ['paste', 'z']);
  assert.strictEqual(done.out[0].text.length, MAX_PASTE);
});

test('a paste whose end never arrives is abandoned after a while', async () => {
  const p = collect({ pasteMs: 25 });
  p.parser.feed('\x1b[200~partial');
  await sleep(80);
  assert.deepStrictEqual(p.out.map((k) => [k.name, k.text]), [['paste', 'partial']]);
  p.parser.feed('k');
  assert.deepStrictEqual(p.names(), ['paste', 'k']);
  p.parser.dispose();
});

test('if the project changes after the review, the review is shown again before anything is written', async () => {
  const ws = workspace(['zeta-app']);
  const project = ws.repo('zeta-app');
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send(KEYS.enter);
  await term.waitFor(/Review/);
  assert.match(term.screen(), /managed\s+2 files\s+create 2/);
  fs.mkdirSync(path.join(project, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude/agents/alpha.md'), '# my own alpha\n');
  await term.send(KEYS.enter);
  await term.waitFor(/The project changed after the plan was made/);
  assert.match(term.screen(), /Review/);
  assert.match(term.screen(), /keep-modified 1/);
  assert.ok(!exists(project, MANIFEST), 'nothing installed from the stale plan');
  assert.ok(!exists(project, '.claude/ai-sdlc.journal.json'), 'lock released while waiting');
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# my own alpha\n');
  assert.strictEqual(read(project, '.claude/agents/alpha.md.new'), '# alpha v1\n');
  assert.ok(exists(project, MANIFEST));
  assertRestored(term);
});
