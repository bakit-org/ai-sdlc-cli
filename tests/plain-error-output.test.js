'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../lib/commands');
const { tmpDir } = require('./helpers');

// An unreadable bundle path carrying control characters must not reach a terminal raw.
async function failWith(stderrIsTTY) {
  const err = [];
  const stderr = { isTTY: stderrIsTTY, write: (s) => err.push(String(s)) };
  const code = await run(['install', '--from-bundle', 'missing\x1b]0;PWNED\x07.json', '--project', tmpDir(), '--yes', '--no-tui'], {
    cwd: process.cwd(), isTTY: false, stdin: process.stdin, stdout: { write() {} }, stderr, home: tmpDir('ai-sdlc-home-'), probePython: () => null,
  });
  return { code, text: err.join('') };
}

test('error text shows control characters as visible escapes on a terminal', async () => {
  const { code, text } = await failWith(true);
  assert.notStrictEqual(code, 0);
  assert.ok(!text.includes('\x1b'), 'no raw ESC');
  assert.ok(text.includes('^[') || text.includes('missing'), text);
});

test('error text is unchanged when stderr is not a terminal', async () => {
  const { text } = await failWith(false);
  assert.ok(text.includes('\x1b]0;PWNED'), 'piped output stays byte-identical');
});
