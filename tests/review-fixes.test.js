'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeBundle, writeBundle, newProject, runCli, read, exists } = require('./helpers');

const install = (project, file, extra = []) => runCli(['install', '--project', project, '--from-bundle', file, '--yes', ...extra]);
const manifestPath = (p) => path.join(p, '.claude/ai-sdlc.manifest.json');

test('uninstall works when .claude is an in-project symlink', async () => {
  const project = newProject();
  fs.mkdirSync(path.join(project, 'shared-claude'));
  fs.symlinkSync('shared-claude', path.join(project, '.claude'), 'dir');
  const file = writeBundle(tmpDir(), makeBundle());
  assert.strictEqual((await install(project, file)).code, 0);
  assert.ok(exists(project, 'shared-claude/agents/alpha.md'));
  const r = await runCli(['uninstall', '--project', project, '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.lstatSync(path.join(project, '.claude')).isSymbolicLink());
  assert.ok(!exists(project, 'shared-claude/agents'));
  assert.ok(!exists(project, 'shared-claude/ai-sdlc.manifest.json'));
});

test('CLAUDE.md or settings.json that are not valid UTF-8 are refused untouched', async () => {
  const bad = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
  const hooks = [{ event: 'Stop', command: 'echo hi' }];
  const file = writeBundle(tmpDir(), makeBundle({ hooks }));
  const p1 = newProject();
  fs.writeFileSync(path.join(p1, 'CLAUDE.md'), bad);
  const r1 = await install(p1, file);
  assert.strictEqual(r1.code, 1);
  assert.match(r1.err, /CLAUDE\.md is not valid UTF-8/);
  assert.ok(fs.readFileSync(path.join(p1, 'CLAUDE.md')).equals(bad));
  assert.ok(!exists(p1, '.claude/agents'));
  const p2 = newProject();
  fs.mkdirSync(path.join(p2, '.claude'));
  fs.writeFileSync(path.join(p2, '.claude/settings.json'), Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  const r2 = await install(p2, file);
  assert.strictEqual(r2.code, 1);
  assert.match(r2.err, /not valid UTF-8/);
  assert.ok(!exists(p2, '.claude/agents'));
});

test('a symlinked CLAUDE.md is still refused, with guidance', async () => {
  const project = newProject();
  fs.writeFileSync(path.join(project, 'real.md'), '# real\n');
  fs.symlinkSync('real.md', path.join(project, 'CLAUDE.md'));
  const r = await install(project, writeBundle(tmpDir(), makeBundle()));
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /symlink.*regular file/);
  assert.strictEqual(read(project, 'real.md'), '# real\n');
});

test('update does not re-create a starter file the user deleted; install --force does', async () => {
  const project = newProject();
  const dir = tmpDir();
  const file = writeBundle(dir, makeBundle());
  await install(project, file);
  fs.rmSync(path.join(project, 'ai-sdlc/project.md'));
  const v2 = writeBundle(dir, makeBundle({ version: '1.1.0' }), { name: 'v2.json' });
  const u = await runCli(['update', '--project', project, '--from-bundle', v2, '--yes']);
  assert.strictEqual(u.code, 0, u.err);
  assert.ok(!exists(project, 'ai-sdlc/project.md'));
  assert.match(u.out, /skip-deleted\s+ai-sdlc\/project\.md/);
  assert.ok(JSON.parse(read(project, '.claude/ai-sdlc.manifest.json')).files.some((f) => f.path === 'ai-sdlc/project.md'));
  assert.strictEqual((await install(project, v2, ['--force'])).code, 0);
  assert.strictEqual(read(project, 'ai-sdlc/project.md'), '# Project\n');
});

test('a starter file that is new in the bundle is created by update', async () => {
  const project = newProject();
  const dir = tmpDir();
  await install(project, writeBundle(dir, makeBundle()));
  const files = [...makeBundle().manifest.files.map((f) => ({ path: f.path, class: f.class })), { path: 'docs/new-starter.md', class: 'user-once' }]
    .map((f) => ({ ...f, text: f.class === 'block' ? 'router\n' : `${f.path}\n` }));
  const r = await runCli(['update', '--project', project, '--from-bundle', writeBundle(dir, makeBundle({ version: '1.1.0', files }), { name: 'v2.json' }), '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(exists(project, 'docs/new-starter.md'));
});

test('doctor turns a throwing check into a FAIL entry, in text and --json', async () => {
  const project = newProject();
  await install(project, writeBundle(tmpDir(), makeBundle()));
  const target = path.join(project, '.claude/agents/alpha.md');
  fs.rmSync(target);
  fs.symlinkSync(path.join(project, 'CLAUDE.md'), target);
  const text = await runCli(['doctor', '--project', project]);
  assert.strictEqual(text.code, 1);
  assert.match(text.out, /\[FAIL\] managed file: .*alpha\.md is a symlink/);
  const json = await runCli(['doctor', '--project', project, '--json']);
  assert.strictEqual(json.code, 1);
  assert.ok(JSON.parse(json.out).checks.some((c) => c.status === 'fail' && /symlink/.test(c.detail)));
});

test('doctor reports a leftover journal even when there is no manifest', async () => {
  const project = newProject();
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude/ai-sdlc.journal.json'), '{}');
  const r = await runCli(['doctor', '--project', project]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /\[FAIL\] journal:/);
  assert.match(r.out, /\[FAIL\] manifest:/);
});

test('doctor finds hook scripts in every CLAUDE_PROJECT_DIR spelling', async () => {
  const hooks = [
    { event: 'Stop', command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/a.js' },
    { event: 'SessionStart', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/b.js' },
    { event: 'PreCompact', command: 'node $CLAUDE_PROJECT_DIR/.claude/hooks/c.js' },
  ];
  const files = ['a', 'b', 'c'].map((n) => ({ path: `.claude/hooks/${n}.js`, class: 'managed', text: `// ${n}\n` }));
  const project = newProject();
  await install(project, writeBundle(tmpDir(), makeBundle({ files, hooks })));
  assert.strictEqual((await runCli(['doctor', '--project', project])).code, 0);
  for (const n of ['a', 'b', 'c']) fs.rmSync(path.join(project, `.claude/hooks/${n}.js`));
  const r = await runCli(['doctor', '--project', project]);
  for (const n of ['a', 'b', 'c']) assert.match(r.out, new RegExp(`\\[FAIL\\] hook script: missing or unusable: \\.claude/hooks/${n}\\.js`));
});

test('an installed manifest with unsafe or misclassified paths is refused before anything is deleted', async () => {
  const bad = ['../victim.txt', '/etc/hosts', '.claude/settings.local.json', '.claude/settings.json', 'CLAUDE.md', 'src/app.js', '.git/config', '.claude/../x'];
  for (const rel of bad) {
    const project = newProject({ 'src/app.js': 'precious\n', '.claude/settings.local.json': '{}\n' });
    await install(project, writeBundle(tmpDir(), makeBundle()));
    const m = JSON.parse(read(project, '.claude/ai-sdlc.manifest.json'));
    const sha = require('crypto').createHash('sha256').update(Buffer.from(rel.startsWith('..') ? 'x' : 'precious\n')).digest('hex');
    m.files.push({ path: rel, class: 'managed', sha256: sha });
    fs.writeFileSync(manifestPath(project), JSON.stringify(m));
    for (const cmd of ['uninstall', 'update']) {
      const args = [cmd, '--project', project, '--yes'];
      if (cmd === 'update') args.push('--from-bundle', writeBundle(tmpDir(), makeBundle()));
      const r = await runCli(args);
      assert.strictEqual(r.code, 1, `${cmd} ${rel}`);
      assert.match(r.err, /unsafe manifest path|manifest .* is invalid/);
    }
    assert.strictEqual(read(project, 'src/app.js'), 'precious\n');
    assert.ok(exists(project, '.claude/agents/alpha.md'));
  }
});

test('bundle paths under .git or reserved settings files are rejected', async () => {
  const cases = [
    { path: '.git/hooks/pre-commit', class: 'user-once' },
    { path: 'sub/.git/config', class: 'user-once' },
    { path: '.claude/settings.local.json', class: 'managed' },
    { path: '.claude/settings.local.json', class: 'user-once' },
    { path: '.claude/settings.json', class: 'managed' },
    { path: '.claude/ai-sdlc.manifest.json', class: 'managed' },
  ];
  for (const c of cases) {
    const project = newProject();
    const r = await install(project, writeBundle(tmpDir(), makeBundle({ files: [{ ...c, text: 'x\n' }] })));
    assert.strictEqual(r.code, 1, `${c.class} ${c.path}`);
    assert.match(r.err, /invalid bundle/);
    assert.ok(!exists(project, '.claude'));
  }
});

test('a block body that contains the markers is rejected', async () => {
  for (const marker of ['<!-- ai-sdlc:begin -->', '<!-- ai-sdlc:end -->']) {
    const files = [{ path: 'CLAUDE.md', class: 'block', text: `intro\n${marker}\n` }];
    const r = await install(newProject(), writeBundle(tmpDir(), makeBundle({ files })));
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /must not contain/);
  }
});

test('a missing checksum file shows up in --json warnings', async () => {
  const project = newProject();
  const file = writeBundle(tmpDir(), makeBundle(), { sidecar: false });
  const r = await runCli(['install', '--project', project, '--from-bundle', file, '--dry-run', '--json']);
  assert.strictEqual(r.code, 0);
  assert.ok(JSON.parse(r.out).warnings.some((w) => /integrity not verified/.test(w)));
  assert.strictEqual(r.err, '');
  const real = await runCli(['install', '--project', project, '--from-bundle', file, '--yes', '--json']);
  assert.ok(JSON.parse(real.out).warnings.some((w) => /integrity not verified/.test(w)));
});

test('usage errors are JSON under --json', async () => {
  for (const args of [['install', '--json', '--bogus'], ['--json', 'frobnicate'], ['install', '--json', '--project']]) {
    const r = await runCli(args);
    assert.strictEqual(r.code, 2);
    const parsed = JSON.parse(r.out);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.exitCode, 2);
    assert.strictEqual(r.err, '');
  }
});

test('rewriting CLAUDE.md and settings.json keeps their permission bits', { skip: process.platform === 'win32' }, async () => {
  const project = newProject({ 'CLAUDE.md': '# mine\n', '.claude/settings.json': '{}\n' });
  fs.chmodSync(path.join(project, 'CLAUDE.md'), 0o600);
  fs.chmodSync(path.join(project, '.claude/settings.json'), 0o640);
  const hooks = [{ event: 'Stop', command: 'echo hi' }];
  const dir = tmpDir();
  assert.strictEqual((await install(project, writeBundle(dir, makeBundle({ hooks })))).code, 0);
  const mode = (rel) => fs.statSync(path.join(project, rel)).mode & 0o777;
  assert.strictEqual(mode('CLAUDE.md'), 0o600);
  assert.strictEqual(mode('.claude/settings.json'), 0o640);
  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  assert.strictEqual(mode('CLAUDE.md'), 0o600);
  assert.strictEqual(mode('.claude/settings.json'), 0o640);
});

test('update leaves settings.json byte-identical when the hook entry is already present', async () => {
  const hooks = [{ event: 'Stop', command: 'echo ours' }];
  const project = newProject({ '.claude/settings.json': '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}' });
  const dir = tmpDir();
  await install(project, writeBundle(dir, makeBundle({ hooks })));
  // The user puts their own entry after ours and reformats the file.
  const s = JSON.parse(read(project, '.claude/settings.json'));
  s.hooks.Stop.reverse();
  const reordered = `${JSON.stringify(s)}\n`;
  fs.writeFileSync(path.join(project, '.claude/settings.json'), reordered);
  const r = await runCli(['update', '--project', project, '--from-bundle', writeBundle(dir, makeBundle({ hooks, version: '1.1.0' }), { name: 'v2.json' }), '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(read(project, '.claude/settings.json'), reordered);
  assert.strictEqual(JSON.parse(read(project, '.claude/ai-sdlc.manifest.json')).hooks.length, 1);
  assert.ok(!r.out.includes('settings'), 'no settings action listed');
});
