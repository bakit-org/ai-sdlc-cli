'use strict';
// Turns raw terminal input into key events:
//   { name, text, ctrl, shift, meta }
// name is 'char' (text holds the character), 'paste' (text holds the pasted
// string), a control letter with ctrl:true ('c', 'u', ...), or one of
// up down left right home end pageup pagedown insert delete enter tab
// backspace escape unknown.

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const ARROWS = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDE = { 1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };
const MAX_PASTE = 1024 * 1024;

const key = (name, extra = {}) => ({ name, text: '', ctrl: false, shift: false, meta: false, ...extra });

function csiKey(params, final) {
  const parts = params.split(';');
  const mod = parts.length > 1 ? Number(parts[1]) - 1 || 0 : 0;
  const mods = { shift: Boolean(mod & 1), meta: Boolean(mod & 2), ctrl: Boolean(mod & 4) };
  if (final === 'Z') return key('tab', { shift: true });
  if (final === '~') return key(TILDE[parts[0]] || 'unknown', mods);
  return key(ARROWS[final] || 'unknown', mods);
}

// feed() accepts chunks as the terminal delivers them: several keys in one
// chunk, a bracketed paste split across chunks, CRLF Enter, an escape
// sequence split across reads.
//   escapeMs  how long a trailing lone ESC (or a bare ESC [ / ESC O) waits for
//             the rest of its sequence before it is reported as the Escape key.
//             0 reports it at once.
//   pasteMs   a bracketed paste that never ends is abandoned after this long.
// An unterminated paste can never swallow Ctrl-C (ETX), and is capped at 1 MB.
function createKeyParser(emit, { escapeMs = 50, pasteMs = 2000 } = {}) {
  let pending = '';
  let paste = null;
  let discarding = false;
  let afterCR = false;
  let escTimer = null;
  let pasteTimer = null;

  const later = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    return t;
  };
  const stopEscTimer = () => {
    if (escTimer) clearTimeout(escTimer);
    escTimer = null;
  };
  const endPaste = (text) => {
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = null;
    if (text !== null) emit(key('paste', { text }));
    paste = null;
    discarding = false;
  };

  function holdEscape(rest) {
    pending = rest;
    if (escapeMs <= 0) return rest === '\x1b' ? flushEscape() : undefined;
    stopEscTimer();
    escTimer = later(flushEscape, escapeMs);
    return undefined;
  }

  // The held ESC was not the start of a sequence: it is the Escape key, and
  // whatever followed it is ordinary input.
  function flushEscape() {
    stopEscTimer();
    const rest = pending;
    pending = '';
    if (!rest) return;
    emit(key('escape'));
    if (rest.length > 1) feed(rest.slice(1));
  }

  function collectPaste(data, i) {
    if (!pasteTimer) pasteTimer = later(() => endPaste(discarding ? null : paste), pasteMs);
    const chunk = data.slice(i);
    const end = (paste + chunk).indexOf(PASTE_END);
    if (end === -1) {
      // No terminator yet: Ctrl-C must still work.
      if (chunk.includes('\x03')) {
        endPaste(null);
        emit(key('c', { ctrl: true }));
        return;
      }
      if (!discarding) paste += chunk;
      if (paste.length > MAX_PASTE) {
        emit(key('paste', { text: paste.slice(0, MAX_PASTE) }));
        paste = '';
        discarding = true;
      }
      return;
    }
    const full = paste + chunk;
    const rest = full.slice(end + PASTE_END.length);
    const text = discarding ? null : full.slice(0, Math.min(end, MAX_PASTE));
    endPaste(text);
    if (rest) feed(rest);
  }

  function feed(chunk) {
    stopEscTimer();
    const data = pending + chunk;
    pending = '';
    let i = 0;
    while (i < data.length) {
      const wasCR = afterCR;
      afterCR = false;

      if (paste !== null) {
        collectPaste(data, i);
        return;
      }

      const c = data[i];
      if (c === '\x1b') {
        const rest = data.slice(i);
        if (rest === '\x1b' || rest === '\x1b[' || rest === '\x1bO') return holdEscape(rest);
        if (rest[1] === '\x1b') {
          emit(key('escape'));
          i += 1;
          continue;
        }
        if (rest.startsWith(PASTE_START)) {
          paste = '';
          i += PASTE_START.length;
          continue;
        }
        const csi = /^\x1b\[([0-9;?]*)([@-~])/.exec(rest);
        if (csi) {
          emit(csiKey(csi[1], csi[2]));
          i += csi[0].length;
          continue;
        }
        const ss3 = /^\x1bO([A-Za-z])/.exec(rest);
        if (ss3) {
          emit(key(ARROWS[ss3[1]] || 'unknown'));
          i += 3;
          continue;
        }
        if (/^\x1b\[[0-9;?]*$/.test(rest) || PASTE_START.startsWith(rest)) {
          return holdEscape(rest); // a longer sequence cut off by the read; wait for the rest
        }
        // ESC + character: an Alt chord. Reported as meta so widgets can ignore it.
        const cp = String.fromCodePoint(rest.codePointAt(1));
        emit(key('char', { text: cp, meta: true }));
        i += 1 + cp.length;
        continue;
      }

      const cp = data.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (ch === '\r') {
        emit(key('enter'));
        afterCR = true;
      } else if (ch === '\n') {
        if (!wasCR) emit(key('enter'));
      } else if (ch === '\t') emit(key('tab'));
      else if (ch === '\x7f' || ch === '\b') emit(key('backspace'));
      else if (cp < 32) emit(key(String.fromCharCode(cp + 96), { ctrl: true }));
      else emit(key('char', { text: ch }));
    }
    return undefined;
  }

  // Drops timers and half-read input (the session is closing).
  function dispose() {
    stopEscTimer();
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = null;
    pending = '';
    paste = null;
  }

  return { feed, dispose };
}

module.exports = { createKeyParser, key, PASTE_START, PASTE_END, MAX_PASTE };
