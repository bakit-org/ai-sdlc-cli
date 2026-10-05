'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, newProject, runCli, read, exists, walk } = require('./helpers');

const KIT = path.resolve(__dirname, '..', '..', 'ai-sdlc-kit');
const available = fs.existsSync(path.join(KIT, 'scripts', 'build-release.js'));

test('a bundle built from the real payload repo installs, passes doctor and uninstalls cleanly', { skip: !available && 'ai-sdlc-kit not found beside this repo' }, async () => {
  const { buildBundle } = require(path.join(KIT, 'scripts', 'build-release.js'));
  const b = buildBundle(KIT);
  const dir = tmpDir();
  const file = path.join(dir, b.name);
  fs.writeFileSync(file, b.json);
  fs.writeFileSync(`${file}.sha256`, `${b.digest}  ${b.name}\n`);

  const project = newProject({ 'CLAUDE.md': '# Existing project notes\n' });
  const r = await runCli(['install', '--project', project, '--from-bundle', file, '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(exists(project, '.claude/ai-sdlc.manifest.json'));
  assert.match(read(project, 'CLAUDE.md'), /^# Existing project notes\n/);
  assert.match(read(project, 'CLAUDE.md'), /ai-sdlc:begin/);

  const doc = await runCli(['doctor', '--project', project, '--from-bundle', file]);
  assert.strictEqual(doc.code, 0, doc.out);

  const manifestFiles = JSON.parse(read(project, '.claude/ai-sdlc.manifest.json')).files;
  assert.ok(manifestFiles.length > 20);
  assert.strictEqual((await runCli(['update', '--project', project, '--from-bundle', file, '--yes'])).code, 0);

  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  assert.strictEqual(read(project, 'CLAUDE.md'), '# Existing project notes\n');
  const leftovers = walk(project).map((f) => path.relative(project, f).split(path.sep).join('/')).filter((f) => !f.startsWith('.git/') && f !== 'CLAUDE.md');
  assert.ok(leftovers.every((f) => manifestFiles.some((m) => m.path === f && m.class === 'user-once')), `unexpected leftovers: ${leftovers}`);
});
