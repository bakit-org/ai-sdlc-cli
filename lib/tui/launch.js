'use strict';
// Decides whether a run may use interactive/coloured screens. Anything that
// asks for scripted behaviour (--json, --yes, --no-tui, TERM=dumb) or lacks a
// terminal on both ends keeps the plain output.

// `io.tui` lets a caller (tests, embedding) force the answer where the streams
// are not real terminals; the flags above still win.
function shouldUseTui(flags, io) {
  if (flags.json || flags.noTui || flags.yes) return false;
  if (io.env.TERM === 'dumb') return false;
  if (io.tui !== undefined) return Boolean(io.tui);
  // Raw key input is required; a stream that cannot switch to raw mode keeps the plain prompts.
  return Boolean(io.stdin.isTTY && io.stdout.isTTY && typeof io.stdin.setRawMode === 'function');
}

// The guided install additionally steps aside for --dry-run (it prints the plan and exits).
const shouldRunWizard = (flags, io) => shouldUseTui(flags, io) && !flags.dryRun;

module.exports = { shouldUseTui, shouldRunWizard };
