'use strict';
// Terminal session: raw keyboard input, a redrawable live frame, resize
// handling, and one cleanup path that always puts the terminal back.
const { StringDecoder } = require('string_decoder');
const { createKeyParser } = require('./keys');
const { truncate, visibleWidth } = require('./text-width');
const { createGuards } = require('./terminal-guards');

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';
const CLEAR_DOWN = '\x1b[J';
const MIN_COLUMNS = 20;
const MIN_ROWS = 8;

// Returned by a screen when the user pressed Esc (or declined) at that step.
const BACK = Object.freeze({ back: true });

// reason: 'interrupt' (Ctrl-C), 'eof' (input closed) or 'escape' (backed out of the first step).
class Cancelled extends Error {
  constructor(reason) {
    super(reason === 'interrupt' ? 'interrupted' : 'cancelled');
    this.name = 'Cancelled';
    this.reason = reason;
  }
}

const isCancelKey = (k) => k.ctrl && k.name === 'c';

// A screen is { init, view(state, ctx) -> string[], onKey(state, key, ctx) -> { state } | { done } }.
// ctx.elapsed is the time since the screen was first shown (screens use it to
// ignore keys that were typed before the user could see them).
function createSession({ stdin, stdout, stderr = process.stderr, theme, proc = process, escapeMs }) {
  const decoder = new StringDecoder('utf8');
  const queue = [];
  let started = false;
  let ended = false;
  let handler = null;
  let screenStart = Date.now();
  let live = null; // array of lines or (ctx) => lines, redrawn on resize
  let widths = []; // visible widths of the lines on screen
  let drawn = { cols: 0, rows: 0 };

  const columns = () => (stdout.columns > 0 ? stdout.columns : 80);
  const rows = () => (stdout.rows > 0 ? stdout.rows : 24);
  const tooSmall = () => columns() < MIN_COLUMNS || rows() < MIN_ROWS;
  const ctx = () => ({ theme, width: Math.max(1, columns() - 1), rows: rows(), columns: columns(), elapsed: Date.now() - screenStart });

  // Rows the current frame occupies if the terminal now has `cols` columns (lines may have re-wrapped).
  const occupied = (cols) => widths.reduce((n, w) => n + Math.max(1, Math.ceil(w / cols)), 0);

  function erase() {
    if (!widths.length) return '';
    const up = occupied(columns()) - 1;
    return `${up > 0 ? `\x1b[${up}A` : ''}\r${CLEAR_DOWN}`;
  }

  const fit = (lines) => lines.map((l) => truncate(l, Math.max(1, columns() - 1), theme.sym.ellipsis));

  function draw(source) {
    if (!started) return;
    live = source;
    let shown;
    if (tooSmall()) shown = fit([`Window too small: enlarge to ${MIN_COLUMNS}x${MIN_ROWS} (Esc cancels)`]);
    else shown = fit((typeof source === 'function' ? source(ctx()) : source).slice(0, Math.max(3, rows() - 1)));
    stdout.write(`${erase()}${shown.join('\n')}`);
    widths = shown.map(visibleWidth);
    drawn = { cols: columns(), rows: rows() };
  }

  // Replaces the live frame with permanent output (it stays in the scrollback).
  function commit(lines) {
    if (!started) return;
    const out = fit(lines);
    stdout.write(`${erase()}${out.join('\n')}${out.length ? '\n' : ''}`);
    widths = [];
    live = null;
  }

  const clear = () => commit([]);

  function pump() {
    while (handler && queue.length) handler(queue.shift());
  }
  const parser = createKeyParser((k) => {
    queue.push(k);
    pump();
  }, escapeMs === undefined ? {} : { escapeMs });
  const onData = (chunk) => parser.feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  const onEnd = () => {
    ended = true;
    if (handler) handler({ name: 'eof' });
  };
  const onResize = () => {
    if (live && (drawn.cols !== columns() || drawn.rows !== rows())) draw(live);
  };

  // The single restore path: exit, signals, fatal errors and close() all land here.
  const guards = createGuards({ stdout, stderr, proc, restore: () => restore(), isActive: () => started });
  function restore() {
    if (!started) return;
    started = false;
    parser.dispose();
    try {
      stdout.write(`${PASTE_OFF}${SHOW_CURSOR}${widths.length ? '\r\n' : ''}`);
    } catch (_) {
      /* output already gone */
    }
    try {
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    } catch (_) {
      /* not a terminal any more */
    }
    stdin.removeListener('data', onData);
    stdin.removeListener('end', onEnd);
    stdin.removeListener('close', onEnd);
    if (typeof stdout.removeListener === 'function') stdout.removeListener('resize', onResize);
    guards.remove();
    if (typeof stdin.pause === 'function') stdin.pause();
    widths = [];
    live = null;
  }
  function start() {
    if (started) return;
    started = true;
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('close', onEnd);
    if (typeof stdout.on === 'function') {
      stdout.on('resize', onResize);
    }
    guards.install();
    stdin.resume();
    stdout.write(`${HIDE_CURSOR}${PASTE_ON}`);
  }

  // Shows the screen and resolves with whatever its onKey returns as `done`.
  // Ctrl-C and closed input reject with Cancelled. Keys typed before the screen
  // existed (Enter pressed during a spinner, say) are dropped, except Ctrl-C.
  function run(screen) {
    return new Promise((resolve, reject) => {
      const stale = queue.splice(0).filter(isCancelKey);
      queue.push(...stale);
      if (ended) return reject(new Cancelled('eof'));
      let state = screen.init;
      screenStart = Date.now();
      const finish = (fn, value) => {
        handler = null;
        fn(value);
      };
      handler = (k) => {
        if (k.name === 'eof') return finish(reject, new Cancelled('eof'));
        if (isCancelKey(k)) return finish(reject, new Cancelled('interrupt'));
        let out;
        try {
          out = screen.onKey(state, k, ctx());
        } catch (err) {
          return finish(reject, err);
        }
        if (out && out.done !== undefined) return finish(resolve, out.done);
        if (out && out.state) state = out.state;
        draw((c) => screen.view(state, c));
        return undefined;
      };
      draw((c) => screen.view(state, c));
      pump();
      return undefined;
    });
  }

  return { start, close: restore, draw, commit, clear, run, ctx, theme, get columns() { return columns(); }, get rows() { return rows(); } };
}

// Opens a session, runs fn(session) and always restores the terminal.
async function withSession(opts, fn) {
  const session = createSession(opts);
  session.start();
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

module.exports = { createSession, withSession, Cancelled, BACK, HIDE_CURSOR, SHOW_CURSOR, PASTE_ON, PASTE_OFF, MIN_COLUMNS, MIN_ROWS };
