'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { exists } = require('./helpers');
const { KEYS } = require('./tui-helpers');
const { MANIFEST, workspace, termFor, start } = require('./tui-wizard-helpers');

test('entering a path: bad input is refused inline, Tab completes, then the install goes ahead', async () => {
  const ws = workspace();
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send(KEYS.end, KEYS.enter);
  await term.waitFor(/Project path/);

  await term.send('~', KEYS.enter);
  assert.match(term.screen(), /refusing to install into the home directory/);
  await term.send(KEYS.ctrlU, path.join(ws.root, 'nope'), KEYS.enter);
  assert.match(term.screen(), /does not exist/);
  fs.writeFileSync(path.join(ws.root, 'a-file.txt'), 'x');
  await term.send(KEYS.ctrlU, path.join(ws.root, 'a-file.txt'), KEYS.enter);
  assert.match(term.screen(), /not a directory/);

  await term.send(KEYS.ctrlU, `${ws.root}${path.sep}ze`, KEYS.tab);
  assert.ok(term.screen().includes(`zeta-app${path.sep}`));
  await term.send(KEYS.enter);
  await term.waitFor(/Review/);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
  assert.ok(exists(ws.repo('zeta-app'), MANIFEST));
  assert.ok(!exists(ws.repo('other-repo'), '.claude'));
});

test('a pasted path is accepted as typed text', async () => {
  const ws = workspace(['zeta-app']);
  const term = termFor(ws);
  const done = start(term, ws, ['init', '--root', ws.root, '--from-bundle', ws.bundle]);
  await term.waitFor(/Select the project/);
  await term.send(KEYS.end, KEYS.enter);
  await term.waitFor(/Project path/);
  await term.send(`${KEYS.pasteStart}${ws.repo('zeta-app')}\r\n${KEYS.pasteEnd}`);
  assert.match(term.screen(), /zeta-app/);
  await term.send(KEYS.enter);
  await term.waitFor(/Review/);
  await term.send(KEYS.enter);
  assert.strictEqual(await done, 0, term.stderrText());
});

