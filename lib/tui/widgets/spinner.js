'use strict';
// A spinner line for work that awaits something (child processes, I/O).
const { Cancelled } = require('../cancelled');

const frame = (theme, tick) => theme.sym.spinner[tick % theme.sym.spinner.length];

const spinnerLine = ({ theme, tick, text }) => `  ${theme.paint('accent', frame(theme, tick))} ${text}`;

// After a cancel the work gets this long to wind down (it is told through the signal) before we stop waiting.
const SETTLE_MS = 1000;

// Animates while `fn(signal)` runs, then clears the line. Resolves with fn's result.
// Ctrl-C, Esc and closed input abort the signal and reject with Cancelled once fn has
// stopped (or SETTLE_MS passed), so work that honours the signal can clean up first.
async function withSpinner(session, text, fn, { intervalMs = 80 } = {}) {
  let tick = 0;
  const controller = new AbortController();
  const show = () => session.draw((ctx) => [spinnerLine({ theme: ctx.theme, tick, text })]);
  show();
  const timer = setInterval(() => {
    tick += 1;
    show();
  }, intervalMs);
  if (timer.unref) timer.unref();
  const unwatch = typeof session.watchCancel === 'function' ? session.watchCancel((reason) => controller.abort(new Cancelled(reason))) : () => {};
  try {
    const work = Promise.resolve().then(() => fn(controller.signal));
    work.catch(() => {});
    const cancelled = new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
    const winner = await Promise.race([work.then((value) => ({ value })), cancelled]);
    if (winner && 'value' in winner) return winner.value;
    await Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, SETTLE_MS).unref())]);
    throw controller.signal.reason;
  } finally {
    unwatch();
    clearInterval(timer);
    session.clear();
  }
}

module.exports = { spinnerLine, withSpinner };
