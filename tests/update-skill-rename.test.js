'use strict';
// A release that renames a skill folder (for example adds the sdlc- namespace): `update` removes the old
// folder's files while they are unmodified, keeps any file the user edited, and installs the new folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeBundle, writeBundle, newProject, runCli, read, exists } = require('./helpers');

const OLD = '.claude/skills/ba-elicit-requirements';
const NEW = '.claude/skills/sdlc-ba-elicit-requirements';
const files = (dir, skill) => [
  { path: `${dir}/SKILL.md`, class: 'managed', text: `---\nname: ${skill}\n---\n# ${skill}\n` },
  { path: `${dir}/scripts/validate.js`, class: 'managed', text: `// ${skill} script\n` },
  { path: `${dir}/references/guide.md`, class: 'managed', text: `# ${skill} guide\n` },
];
const common = [{ path: 'CLAUDE.md', class: 'block', text: '## router\n' }];

async function setup() {
  const project = newProject();
  const dir = tmpDir();
  const v1 = writeBundle(dir, makeBundle({ version: '1.0.0', files: [...files(OLD, 'ba-elicit-requirements'), ...common] }));
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', v1, '--yes'])).code, 0);
  const v2 = writeBundle(dir, makeBundle({ version: '1.1.0', files: [...files(NEW, 'sdlc-ba-elicit-requirements'), ...common] }), { name: 'v2.bundle.json' });
  return { project, v2 };
}

test('update to a renamed skill folder removes the unmodified old folder and adds the new one', async () => {
  const { project, v2 } = await setup();
  const r = await runCli(['update', '--project', project, '--from-bundle', v2, '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(!exists(project, OLD), 'old skill folder should be gone');
  for (const f of files(NEW, 'sdlc-ba-elicit-requirements')) assert.strictEqual(read(project, f.path), f.text);
  const manifest = JSON.parse(read(project, '.claude/ai-sdlc.manifest.json'));
  assert.strictEqual(manifest.payload_version, '1.1.0');
  assert.ok(manifest.files.every((f) => !f.path.startsWith(`${OLD}/`)));
  assert.ok(manifest.files.some((f) => f.path === `${NEW}/SKILL.md`));
});

test('update keeps a user-modified file of the old skill folder and still adds the new one', async () => {
  const { project, v2 } = await setup();
  fs.writeFileSync(path.join(project, OLD, 'references/guide.md'), '# my notes\n');
  const r = await runCli(['update', '--project', project, '--from-bundle', v2, '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(project, `${OLD}/references/guide.md`), '# my notes\n');
  assert.ok(!exists(project, `${OLD}/SKILL.md`));
  assert.ok(!exists(project, `${OLD}/scripts/validate.js`));
  assert.strictEqual(read(project, `${NEW}/SKILL.md`), '---\nname: sdlc-ba-elicit-requirements\n---\n# sdlc-ba-elicit-requirements\n');
  assert.ok(exists(project, `${NEW}/scripts/validate.js`));
  assert.ok(exists(project, `${NEW}/references/guide.md`));
  // The edited leftover is the user's now: uninstall does not touch it either.
  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  assert.strictEqual(read(project, `${OLD}/references/guide.md`), '# my notes\n');
  assert.ok(!exists(project, NEW));
});
