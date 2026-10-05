'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { deadPid, tmpDir, makeBundle, writeBundle, newProject, runCli, read, exists, walk } = require('./helpers');

const snapshot = (dir) => Object.fromEntries(walk(dir).filter((f) => !f.includes(`${path.sep}.git${path.sep}`)).map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]));

async function install(project, bundleFile, extra = []) {
  return runCli(['install', '--project', project, '--from-bundle', bundleFile, '--yes', ...extra]);
}

test('fresh install writes managed files, block, scaffold and manifest', async () => {
  const project = newProject();
  const bundle = writeBundle(tmpDir(), makeBundle());
  const r = await install(project, bundle);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# alpha v1\n');
  assert.match(read(project, 'CLAUDE.md'), /<!-- ai-sdlc:begin -->\n## ai-sdlc router\nUse the agents.\n<!-- ai-sdlc:end -->\n/);
  assert.strictEqual(read(project, 'ai-sdlc/project.md'), '# Project\n');
  const manifest = JSON.parse(read(project, '.claude/ai-sdlc.manifest.json'));
  assert.strictEqual(manifest.payload_version, '1.0.0');
  assert.strictEqual(manifest.files.length, 3);
  assert.ok(!exists(project, '.claude/ai-sdlc.journal.json'));
});

test('re-install is refused without --force and changes nothing', async () => {
  const project = newProject();
  const bundle = writeBundle(tmpDir(), makeBundle());
  await install(project, bundle);
  const before = snapshot(project);
  const r = await install(project, bundle);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /already installed/);
  assert.deepStrictEqual(snapshot(project), before);
  assert.strictEqual((await install(project, bundle, ['--force'])).code, 0);
});

test('dry-run writes nothing and lists exactly what the real run does', async () => {
  const project = newProject({ 'CLAUDE.md': '# mine\n' });
  const bundle = writeBundle(tmpDir(), makeBundle());
  const before = snapshot(project);
  const dry = await runCli(['install', '--project', project, '--from-bundle', bundle, '--dry-run', '--json']);
  assert.strictEqual(dry.code, 0);
  assert.deepStrictEqual(snapshot(project), before);
  const real = await runCli(['install', '--project', project, '--from-bundle', bundle, '--yes', '--json']);
  assert.strictEqual(real.code, 0);
  assert.deepStrictEqual(JSON.parse(real.out).actions, JSON.parse(dry.out).actions);
  assert.ok(JSON.parse(dry.out).actions.length >= 5);
});

test('update replaces unmodified files, keeps edited ones and writes .new beside them', async () => {
  const project = newProject();
  const dir = tmpDir();
  await install(project, writeBundle(dir, makeBundle()));
  fs.writeFileSync(path.join(project, '.claude/agents/alpha.md'), '# my edit\n');
  fs.writeFileSync(path.join(project, 'ai-sdlc/project.md'), '# my project\n');
  const v2 = makeBundle({
    version: '1.1.0',
    files: [
      { path: '.claude/agents/alpha.md', class: 'managed', text: '# alpha v2\n' },
      { path: '.claude/skills/beta/SKILL.md', class: 'managed', text: '# beta v2\n' },
      { path: '.claude/skills/gamma/SKILL.md', class: 'managed', text: '# gamma\n' },
      { path: 'CLAUDE.md', class: 'block', text: '## router v2\n' },
      { path: 'ai-sdlc/project.md', class: 'user-once', text: '# Project v2\n' },
    ],
  });
  const r = await runCli(['update', '--project', project, '--from-bundle', writeBundle(dir, v2, { name: 'v2.bundle.json' }), '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# my edit\n');
  assert.strictEqual(read(project, '.claude/agents/alpha.md.new'), '# alpha v2\n');
  assert.strictEqual(read(project, '.claude/skills/beta/SKILL.md'), '# beta v2\n');
  assert.strictEqual(read(project, '.claude/skills/gamma/SKILL.md'), '# gamma\n');
  assert.strictEqual(read(project, 'ai-sdlc/project.md'), '# my project\n');
  assert.match(read(project, 'CLAUDE.md'), /## router v2/);
  assert.doesNotMatch(read(project, 'CLAUDE.md'), /Use the agents/);
  assert.strictEqual(JSON.parse(read(project, '.claude/ai-sdlc.manifest.json')).payload_version, '1.1.0');
});

test('update deletes files no longer shipped unless the user changed them', async () => {
  const project = newProject();
  const dir = tmpDir();
  await install(project, writeBundle(dir, makeBundle()));
  fs.writeFileSync(path.join(project, '.claude/skills/beta/SKILL.md'), '# edited\n');
  const v2 = makeBundle({ version: '1.1.0', files: [{ path: 'CLAUDE.md', class: 'block', text: 'x\n' }] });
  const r = await runCli(['update', '--project', project, '--from-bundle', writeBundle(dir, v2, { name: 'v2.bundle.json' }), '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(!exists(project, '.claude/agents/alpha.md'));
  assert.ok(!exists(project, '.claude/agents'));
  assert.strictEqual(read(project, '.claude/skills/beta/SKILL.md'), '# edited\n');
});

for (const [label, original] of [
  ['trailing newline', '# Mine\n\nnotes\n'],
  ['no trailing newline', '# Mine\nnotes'],
  ['CRLF line endings', '# Mine\r\nnotes\r\n'],
  ['empty file', ''],
]) {
  test(`uninstall restores CLAUDE.md byte-for-byte (${label})`, async () => {
    const project = newProject({ 'CLAUDE.md': original });
    const bundle = writeBundle(tmpDir(), makeBundle());
    assert.strictEqual((await install(project, bundle)).code, 0);
    assert.notStrictEqual(read(project, 'CLAUDE.md'), original);
    assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
    assert.strictEqual(read(project, 'CLAUDE.md'), original);
  });
}

test('install then uninstall leaves no trace when the project had no CLAUDE.md or settings', async () => {
  const project = newProject({ 'README.md': 'hi\n' });
  const before = snapshot(project);
  const hooks = [{ event: 'PostToolUse', matcher: 'Write', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sync.js"' }];
  const files = [
    { path: '.claude/hooks/sync.js', class: 'managed', text: '// hook\n' },
    { path: 'CLAUDE.md', class: 'block', text: 'router\n' },
    { path: 'docs/design/README.md', class: 'user-once', text: 'design\n' },
  ];
  const bundle = writeBundle(tmpDir(), makeBundle({ files, hooks }));
  assert.strictEqual((await install(project, bundle)).code, 0);
  assert.ok(exists(project, '.claude/settings.json'));
  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  const after = snapshot(project);
  delete after['docs/design/README.md']; // user-once scaffolds stay by design
  assert.deepStrictEqual(after, before);
});

test('uninstall keeps modified managed files and user-once scaffolds', async () => {
  const project = newProject();
  await install(project, writeBundle(tmpDir(), makeBundle()));
  fs.writeFileSync(path.join(project, '.claude/agents/alpha.md'), '# changed\n');
  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# changed\n');
  assert.ok(!exists(project, '.claude/skills/beta/SKILL.md'));
  assert.ok(exists(project, 'ai-sdlc/project.md'));
  assert.ok(!exists(project, '.claude/ai-sdlc.manifest.json'));
});

test('a foreign file at a managed path is kept on first install, with .new beside it', async () => {
  const project = newProject({ '.claude/agents/alpha.md': '# theirs\n' });
  const r = await install(project, writeBundle(tmpDir(), makeBundle()));
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# theirs\n');
  assert.strictEqual(read(project, '.claude/agents/alpha.md.new'), '# alpha v1\n');
  await runCli(['uninstall', '--project', project, '--yes']);
  assert.strictEqual(read(project, '.claude/agents/alpha.md'), '# theirs\n');
});

test('update and uninstall refuse a project without a manifest', async () => {
  const project = newProject();
  const bundle = writeBundle(tmpDir(), makeBundle());
  assert.strictEqual((await runCli(['update', '--project', project, '--from-bundle', bundle, '--yes'])).code, 1);
  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 1);
});

test('a leftover journal blocks further changes until --force', async () => {
  const project = newProject();
  const bundle = writeBundle(tmpDir(), makeBundle());
  await install(project, bundle);
  fs.writeFileSync(path.join(project, '.claude/ai-sdlc.journal.json'), JSON.stringify({ op: 'install', pid: deadPid(), entries: [] }));
  assert.strictEqual((await runCli(['update', '--project', project, '--from-bundle', bundle, '--yes'])).code, 1);
  assert.strictEqual((await runCli(['update', '--project', project, '--from-bundle', bundle, '--yes', '--force'])).code, 0);
  assert.ok(!exists(project, '.claude/ai-sdlc.journal.json'));
});

test('a failure during apply rolls everything back', async () => {
  const project = newProject({ 'CLAUDE.md': '# mine\n' });
  // A regular file where a directory is needed: the second payload write fails after the first succeeded.
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude/skills'), 'not a directory');
  const before = snapshot(project);
  const r = await install(project, writeBundle(tmpDir(), makeBundle()));
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(snapshot(project), before);
  assert.ok(!exists(project, '.claude/agents'));
});
