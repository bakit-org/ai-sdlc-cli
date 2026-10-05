'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/commands');
const { tmpDir, makeBundle, writeBundle, exists } = require('./helpers');
const { makeTerm } = require('./tui-helpers');
const { SHOW_CURSOR, PASTE_OFF } = require('../lib/tui/terminal');

const MANIFEST = '.claude/ai-sdlc.manifest.json';

// A temp "workspace" holding git repositories, an XDG config dir and a bundle.
function workspace(repos = ['zeta-app', 'other-repo']) {
  const root = tmpDir();
  for (const r of repos) fs.mkdirSync(path.join(root, r, '.git'), { recursive: true });
  const xdg = tmpDir();
  return { root, xdg, home: tmpDir(), bundle: writeBundle(tmpDir(), makeBundle()), repo: (n) => path.join(root, n) };
}

const termFor = (ws, extra = {}) => makeTerm({ env: { NO_COLOR: '1', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: ws.xdg }, ...extra });
const start = (term, ws, args, extra = {}) => run(args, term.runEnv({ cwd: ws.root, home: ws.home, ...extra }));
const assertRestored = (term) => {
  assert.deepStrictEqual(term.stdin.rawCalls, [true, false], 'raw mode switched on and off exactly once');
  assert.ok(term.raw().includes(PASTE_OFF + SHOW_CURSOR), 'cursor shown and paste mode off');
  assert.strictEqual(term.stdin.listenerCount('data'), 0);
  assert.strictEqual(term.proc.listenerCount('SIGINT'), 0);
};
const untouched = (ws, name = 'zeta-app') => {
  assert.ok(!exists(ws.repo(name), '.claude'), 'no .claude directory');
  assert.ok(!exists(ws.repo(name), 'CLAUDE.md'));
  assert.deepStrictEqual(fs.readdirSync(ws.repo(name)), ['.git']);
};

module.exports = { MANIFEST, workspace, termFor, start, assertRestored, untouched };
