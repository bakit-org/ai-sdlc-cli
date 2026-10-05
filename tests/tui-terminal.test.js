'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTheme } = require('../lib/tui/theme');
const { createSession, withSession, Cancelled, BACK, SHOW_CURSOR, HIDE_CURSOR, PASTE_ON, PASTE_OFF } = require('../lib/tui/terminal');
const { createSelectList } = require('../lib/tui/widgets/select-list');
const { stripAnsi } = require('../lib/tui/text-width');
const { makeTerm, KEYS, tick } = require('./tui-helpers');

const theme = createTheme({ level: 0, unicode: true, attrs: false });
const opts = (t) => ({ stdin: t.stdin, stdout: t.stdout, stderr: t.stderr, proc: t.proc, theme, escapeMs: 15 });
// Wraps a promise so a rejection that happens while the test is still typing is not "unhandled".
// Returns a function that yields the promise's result (or rethrows its error) later.
const guard = (promise) => {
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
  return () => outcome.then((o) => { if (o.error) throw o.error; return o.value; });
};
const counter = { init: { n: 0 }, view: (s) => [`count ${s.n}`], onKey: (s, k) => (k.name === 'enter' ? { done: s.n } : { state: { n: s.n + 1 } }) };

test('start puts the terminal in raw mode, hides the cursor and enables paste; close undoes all of it', async () => {
  const t = makeTerm();
  const s = createSession(opts(t));
  s.start();
  assert.deepStrictEqual(t.stdin.rawCalls, [true]);
  assert.ok(t.raw().includes(HIDE_CURSOR + PASTE_ON));
  s.close();
  assert.deepStrictEqual(t.stdin.rawCalls, [true, false]);
  assert.ok(t.raw().endsWith(PASTE_OFF + SHOW_CURSOR));
  assert.strictEqual(t.proc.listenerCount('exit') + t.proc.listenerCount('SIGINT') + t.proc.listenerCount('SIGTERM') + t.proc.listenerCount('uncaughtException'), 0);
  assert.strictEqual(t.stdin.listenerCount('data'), 0);
  s.close();
  assert.deepStrictEqual(t.stdin.rawCalls, [true, false], 'closing twice does nothing more');
});

test('Ctrl-C rejects with Cancelled and the terminal is restored by withSession', async () => {
  const t = makeTerm();
  await assert.rejects(
    withSession(opts(t), async (s) => {
      const result = guard(s.run(counter));
      await t.send('a', KEYS.ctrlC);
      return result();
    }),
    (err) => err instanceof Cancelled && err.reason === 'interrupt',
  );
  assert.deepStrictEqual(t.stdin.rawCalls, [true, false]);
  assert.ok(t.raw().includes(PASTE_OFF + SHOW_CURSOR));
});

test('an error thrown inside the session still restores the terminal', async () => {
  const t = makeTerm();
  await assert.rejects(withSession(opts(t), async () => { throw new Error('boom'); }), /boom/);
  assert.deepStrictEqual(t.stdin.rawCalls, [true, false]);
  assert.ok(t.raw().includes(SHOW_CURSOR));
  const t2 = makeTerm();
  const bad = { init: {}, view: () => ['x'], onKey: () => { throw new Error('widget bug'); } };
  await assert.rejects(withSession(opts(t2), async (s) => {
    const result = guard(s.run(bad));
    await t2.send('a');
    return result();
  }), /widget bug/);
  assert.deepStrictEqual(t2.stdin.rawCalls, [true, false]);
});

test('SIGINT, SIGTERM and uncaught exceptions restore the terminal then exit', () => {
  for (const [event, arg, code] of [['SIGINT', undefined, 130], ['SIGTERM', undefined, 143], ['uncaughtException', new Error('late failure'), 1]]) {
    const t = makeTerm();
    createSession(opts(t)).start();
    t.proc.emit(event, arg);
    assert.deepStrictEqual(t.stdin.rawCalls, [true, false], event);
    assert.ok(t.raw().includes(PASTE_OFF + SHOW_CURSOR), event);
    assert.deepStrictEqual(t.proc.exitCodes, [code], event);
    if (arg) assert.match(t.stderrText(), /late failure/);
  }
});

test('process exit restores the terminal too', () => {
  const t = makeTerm();
  createSession(opts(t)).start();
  t.proc.emit('exit', 0);
  assert.deepStrictEqual(t.stdin.rawCalls, [true, false]);
  assert.ok(t.raw().includes(SHOW_CURSOR));
});

test('closed input rejects the running screen as cancelled', async () => {
  const t = makeTerm();
  const s = createSession(opts(t));
  s.start();
  const pending = s.run(counter);
  t.stdin.end();
  await assert.rejects(pending, (err) => err instanceof Cancelled && err.reason === 'eof');
  s.close();
});

test('redraw moves the cursor up over the previous frame and clears it', async () => {
  const t = makeTerm();
  const s = createSession(opts(t));
  s.start();
  const screen = { init: { n: 0 }, view: (st) => ['line one', `line two ${st.n}`, 'line three'], onKey: (st, k) => (k.name === 'enter' ? { done: 1 } : { state: { n: st.n + 1 } }) };
  const pending = s.run(screen);
  await t.send('x');
  assert.ok(t.raw().includes('\x1b[2A\r\x1b[J'), 'three lines: up two, carriage return, clear down');
  assert.match(t.screen(), /line two 1/);
  await t.send(KEYS.enter);
  await pending;
  s.commit(['kept']);
  assert.ok(t.raw().endsWith('kept\n'));
  s.close();
});

test('keys typed before a screen exists are dropped, so Enter cannot skip a step', async () => {
  const t = makeTerm();
  const s = createSession(opts(t));
  s.start();
  const first = s.run(counter);
  t.stdin.write('ab\rc\r');
  assert.strictEqual(await first, 2);
  const second = guard(s.run(counter));
  await tick();
  assert.match(t.screen(), /count 0/, 'the typed-ahead c and Enter never reached the second screen');
  t.stdin.write('x\r');
  assert.strictEqual(await second(), 1);
  s.close();
});

test('Ctrl-C typed while no screen is showing still cancels the next one', async () => {
  const t = makeTerm();
  const s = createSession(opts(t));
  s.start();
  t.stdin.write('\r\x03');
  await tick();
  await assert.rejects(s.run(counter), (e) => e instanceof Cancelled && e.reason === 'interrupt');
  s.close();
});

test('input that ended between screens is remembered: the next screen is cancelled at once', async () => {
  for (const event of ['end', 'close']) {
    const t = makeTerm();
    const s = createSession(opts(t));
    s.start();
    t.stdin.emit(event);
    await assert.rejects(s.run(counter), (e) => e instanceof Cancelled && e.reason === 'eof', event);
    s.close();
  }
});

test('multi-byte characters split across chunks are decoded intact', async () => {
  const t = makeTerm();
  const s = createSession(opts(t));
  s.start();
  const seen = [];
  const pending = s.run({ init: {}, view: () => ['x'], onKey: (st, k) => (k.name === 'enter' ? { done: seen.join('') } : (seen.push(k.text), { state: st })) });
  const bytes = Buffer.from('日');
  t.stdin.write(bytes.subarray(0, 1));
  await tick();
  t.stdin.write(bytes.subarray(1));
  await tick();
  t.stdin.write('\r');
  assert.strictEqual(await pending, '日');
  s.close();
});

test('resize redraws the live frame at the new width', async () => {
  const t = makeTerm({ columns: 60 });
  const s = createSession(opts(t));
  s.start();
  const list = createSelectList({ title: 'Pick', items: [{ label: 'alpha', value: 1 }] });
  const pending = s.run(list);
  const topBorder = () => t.screen().split('\n').find((l) => l.startsWith('╭'));
  assert.strictEqual(topBorder().length, 59 - 0 > 100 ? 100 : 59);
  t.stdout.columns = 40;
  t.stdout.emit('resize');
  assert.strictEqual(topBorder().length, 39, 'the box was rebuilt for 40 columns');
  t.stdout.columns = 120;
  t.stdout.emit('resize');
  assert.strictEqual(topBorder().length, 100, 'boxes stop growing at 100 columns');
  await t.send(KEYS.esc);
  assert.strictEqual(await pending, BACK);
  s.close();
});

test('lines longer than the terminal are cut with an ellipsis, never wrapped', async () => {
  const t = makeTerm({ columns: 30 });
  const s = createSession(opts(t));
  s.start();
  s.draw(['x'.repeat(80)]);
  const line = stripAnsi(t.raw().split(PASTE_ON).pop());
  assert.strictEqual(line.length, 29);
  assert.ok(line.endsWith('…'));
  s.close();
});
