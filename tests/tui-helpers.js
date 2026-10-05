'use strict';
// A scripted terminal: PassThrough streams that look like a TTY, a fake process
// object, and helpers to type keys and wait for what is on screen.
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const { stripAnsi } = require('../lib/tui/text-width');

const KEYS = {
  enter: '\r', esc: '\x1b', tab: '\t', shiftTab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', del: '\x1b[3~', backspace: '\x7f', ctrlC: '\x03', ctrlU: '\x15', ctrlW: '\x17', ctrlA: '\x01', ctrlE: '\x05',
  pasteStart: '\x1b[200~', pasteEnd: '\x1b[201~',
};

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ESC_WAIT_MS = 40;
const ESCAPE_MS = 15;

function makeTerm({ columns = 100, rows = 30, env = { NO_COLOR: '1', LANG: 'en_US.UTF-8' } } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.rawCalls = [];
  stdin.setRawMode = (on) => stdin.rawCalls.push(on);
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  const chunks = [];
  stdout.on('data', (c) => chunks.push(String(c)));
  const stderrChunks = [];
  const stderr = { write: (s) => stderrChunks.push(String(s)) };
  const proc = new EventEmitter();
  proc.exitCodes = [];
  proc.exit = (code) => proc.exitCodes.push(code);

  const term = {
    stdin, stdout, stderr, proc, env, columns, rows,
    raw: () => chunks.join(''),
    stderrText: () => stderrChunks.join(''),
    // What the live frame shows right now: everything after the last "clear down".
    screen: () => stripAnsi(chunks.join('').split('\x1b[J').pop()),
    // Everything printed, escape sequences removed.
    plain: () => stripAnsi(chunks.join('')),
    async send(...parts) {
      for (const p of parts) {
        stdin.write(p);
        await tick();
        await tick();
        // A lone Escape is held briefly in case it starts a longer sequence.
        if (p.endsWith('\x1b')) await sleep(ESC_WAIT_MS);
      }
    },
    async waitFor(re, { within = 3000, from = 'screen' } = {}) {
      const deadline = Date.now() + within;
      while (Date.now() < deadline) {
        if (re.test(term[from]())) return term[from]();
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timed out waiting for ${re}; screen was:\n${term.screen()}`);
    },
    // Options for lib/commands.run() that route it through this terminal.
    runEnv(extra = {}) {
      return { stdin, stdout, stderr, proc, env, tui: true, execFile: gitStub, escapeMs: ESCAPE_MS, confirmGuardMs: 0, ...extra };
    },
  };
  return term;
}

const gitStub = (cmd, args, opts, cb) => cb(null, 'git version 2.40.0\n');

module.exports = { KEYS, makeTerm, tick, sleep, gitStub, ESCAPE_MS };
