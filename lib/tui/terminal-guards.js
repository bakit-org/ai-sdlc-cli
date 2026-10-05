'use strict';
// Process-level safety nets for a terminal session: whichever way the process
// ends (exit, SIGINT, SIGTERM, an uncaught error, a dead stdout), the session's
// restore() runs first.

function createGuards({ stdout, stderr, proc, restore, isActive }) {
  const report = (text) => {
    try {
      stderr.write(text);
    } catch (_) {
      /* nowhere left to report to */
    }
  };
  const onExit = () => restore();
  const onSigint = () => {
    restore();
    proc.exit(130);
  };
  const onSigterm = () => {
    restore();
    proc.exit(143);
  };
  const onFatal = (err) => {
    restore();
    report(`ai-sdlc: unexpected error: ${err && err.stack ? err.stack : err}\n`);
    proc.exit(1);
  };
  // A closed pipe or a vanished terminal: restore what can be restored and leave quietly.
  function onStdoutError(err) {
    if (!isActive()) return;
    restore();
    if (!err || (err.code !== 'EPIPE' && err.code !== 'EIO')) report(`ai-sdlc: terminal error: ${err.message}\n`);
    proc.exit(1);
  }

  return {
    install() {
      if (typeof stdout.on === 'function') stdout.on('error', onStdoutError);
      proc.on('exit', onExit);
      proc.on('SIGINT', onSigint);
      proc.on('SIGTERM', onSigterm);
      proc.on('uncaughtException', onFatal);
    },
    remove() {
      proc.removeListener('exit', onExit);
      proc.removeListener('SIGINT', onSigint);
      proc.removeListener('SIGTERM', onSigterm);
      proc.removeListener('uncaughtException', onFatal);
      if (typeof stdout.removeListener === 'function') {
        // A write to a dead terminal can still report its error later; keep absorbing it briefly.
        const t = setTimeout(() => stdout.removeListener('error', onStdoutError), 250);
        if (t.unref) t.unref();
      }
    },
  };
}

module.exports = { createGuards };
