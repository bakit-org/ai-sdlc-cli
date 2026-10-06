'use strict';
// Runs `fn` (synchronous cleanup) when the process is told to stop with SIGINT or SIGTERM,
// then exits with the conventional 130 / 143. Returns a function that removes the handlers.
function onTermination(proc, fn) {
  const handler = (code) => () => {
    try {
      fn();
    } finally {
      proc.exit(code);
    }
  };
  const onInt = handler(130);
  const onTerm = handler(143);
  proc.on('SIGINT', onInt);
  proc.on('SIGTERM', onTerm);
  return () => {
    proc.removeListener('SIGINT', onInt);
    proc.removeListener('SIGTERM', onTerm);
  };
}

module.exports = { onTermination };
