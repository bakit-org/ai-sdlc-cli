'use strict';
// Options for a terminal session built from the command's io.
const sessionOptions = (io, theme) => ({
  stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, theme, proc: io.proc, escapeMs: io.escapeMs,
});

module.exports = { sessionOptions };
