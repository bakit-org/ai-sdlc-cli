#!/usr/bin/env node
'use strict';
const { run } = require('../lib/commands');

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`ai-sdlc: unexpected error: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
