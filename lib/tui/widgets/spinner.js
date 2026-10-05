'use strict';
// A spinner line for work that awaits something (child processes, I/O).

const frame = (theme, tick) => theme.sym.spinner[tick % theme.sym.spinner.length];

const spinnerLine = ({ theme, tick, text }) => `  ${theme.paint('accent', frame(theme, tick))} ${text}`;

// Animates while `fn()` runs, then clears the line. Resolves with fn's result.
async function withSpinner(session, text, fn, { intervalMs = 80 } = {}) {
  let tick = 0;
  const show = () => session.draw((ctx) => [spinnerLine({ theme: ctx.theme, tick, text })]);
  show();
  const timer = setInterval(() => {
    tick += 1;
    show();
  }, intervalMs);
  if (timer.unref) timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    session.clear();
  }
}

module.exports = { spinnerLine, withSpinner };
