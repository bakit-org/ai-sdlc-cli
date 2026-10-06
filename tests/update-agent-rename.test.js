'use strict';
// A release that renames agent files (for example adds the sdlc- namespace): `update` removes each old
// agent file while it is unmodified, keeps any file the user edited, and installs the new files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeBundle, writeBundle, newProject, runCli, read, exists } = require('./helpers');

const NAMES = ['business-analyst', 'developer', 'test', 'agent-skill-builder'];
const agent = (name) => ({ path: `.claude/agents/${name}.md`, class: 'managed', text: `---\nname: ${name}\n---\n# ${name}\n` });
const common = [{ path: 'CLAUDE.md', class: 'block', text: '## router\n' }];

async function setup() {
  const project = newProject();
  const dir = tmpDir();
  const v1 = writeBundle(dir, makeBundle({ version: '1.0.0', files: [...NAMES.map(agent), ...common] }));
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', v1, '--yes'])).code, 0);
  const v2 = writeBundle(dir, makeBundle({ version: '1.1.0', files: [...NAMES.map((n) => agent(`sdlc-${n}`)), ...common] }), { name: 'v2.bundle.json' });
  return { project, v2 };
}

test('update to renamed agent files removes the unmodified old agents and adds the sdlc- ones', async () => {
  const { project, v2 } = await setup();
  const r = await runCli(['update', '--project', project, '--from-bundle', v2, '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  for (const n of NAMES) {
    assert.ok(!exists(project, `.claude/agents/${n}.md`), `${n}: old agent file should be gone`);
    assert.strictEqual(read(project, `.claude/agents/sdlc-${n}.md`), agent(`sdlc-${n}`).text);
  }
  const manifest = JSON.parse(read(project, '.claude/ai-sdlc.manifest.json'));
  assert.strictEqual(manifest.payload_version, '1.1.0');
  assert.deepStrictEqual(
    manifest.files.filter((f) => f.path.startsWith('.claude/agents/')).map((f) => f.path).sort(),
    NAMES.map((n) => `.claude/agents/sdlc-${n}.md`).sort(),
  );
});

test('update keeps a user-modified old agent file and still adds the sdlc- agents', async () => {
  const { project, v2 } = await setup();
  fs.writeFileSync(path.join(project, '.claude/agents/developer.md'), '# my own developer agent\n');
  const r = await runCli(['update', '--project', project, '--from-bundle', v2, '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(project, '.claude/agents/developer.md'), '# my own developer agent\n');
  for (const n of NAMES.filter((x) => x !== 'developer')) assert.ok(!exists(project, `.claude/agents/${n}.md`), `${n}: unmodified old file removed`);
  for (const n of NAMES) assert.strictEqual(read(project, `.claude/agents/sdlc-${n}.md`), agent(`sdlc-${n}`).text);
  // The edited file is the user's now: uninstall leaves it alone and removes only the managed sdlc- files.
  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  assert.strictEqual(read(project, '.claude/agents/developer.md'), '# my own developer agent\n');
  for (const n of NAMES) assert.ok(!exists(project, `.claude/agents/sdlc-${n}.md`), `${n}: sdlc- file removed on uninstall`);
});
