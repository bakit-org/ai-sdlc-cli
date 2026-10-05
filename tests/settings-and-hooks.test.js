'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, makeBundle, writeBundle, newProject, runCli, read, exists } = require('./helpers');

const HOOK = { event: 'PostToolUse', matcher: 'Write|Edit', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sync.js"' };
const HOOK2 = { event: 'Stop', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/stop.js"' };
const files = [
  { path: '.claude/hooks/sync.js', class: 'managed', text: '// sync\n' },
  { path: '.claude/hooks/stop.js', class: 'managed', text: '// stop\n' },
  { path: 'CLAUDE.md', class: 'block', text: 'router\n' },
];
const withHooks = (hooks, version = '1.0.0') => makeBundle({ files, hooks, version });
const install = (project, b, extra = []) => runCli(['install', '--project', project, '--from-bundle', b, '--yes', ...extra]);
const settingsOf = (p) => JSON.parse(read(p, '.claude/settings.json'));

test('invalid settings.json aborts the install and leaves everything untouched', async () => {
  const broken = '{ "hooks": { oops ';
  const project = newProject({ '.claude/settings.json': broken, 'CLAUDE.md': '# mine\n' });
  const r = await install(project, writeBundle(tmpDir(), withHooks([HOOK])));
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /settings\.json is not valid JSON/);
  assert.strictEqual(read(project, '.claude/settings.json'), broken);
  assert.strictEqual(read(project, 'CLAUDE.md'), '# mine\n');
  assert.ok(!exists(project, '.claude/hooks'));
  assert.ok(!exists(project, '.claude/ai-sdlc.manifest.json'));
});

test('settings.json with the wrong shape is refused too', async () => {
  for (const text of ['[]', '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
    const project = newProject({ '.claude/settings.json': text });
    const r = await install(project, writeBundle(tmpDir(), withHooks([HOOK])));
    assert.strictEqual(r.code, 1, text);
    assert.strictEqual(read(project, '.claude/settings.json'), text);
  }
});

test('hooks from the manifest merge next to existing user hooks and keep their formatting', async () => {
  const original = '{\n\t"model": "x",\n\t"hooks": {\n\t\t"Stop": [{ "hooks": [{ "type": "command", "command": "echo mine" }] }]\n\t}\n}\n';
  const project = newProject({ '.claude/settings.json': original });
  assert.strictEqual((await install(project, writeBundle(tmpDir(), withHooks([HOOK, HOOK2])))).code, 0);
  const s = settingsOf(project);
  assert.strictEqual(s.model, 'x');
  assert.strictEqual(s.hooks.Stop.length, 2);
  assert.deepStrictEqual(s.hooks.Stop[0].hooks[0].command, 'echo mine');
  assert.deepStrictEqual(s.hooks.Stop[1], { hooks: [{ type: 'command', command: HOOK2.command }] });
  assert.deepStrictEqual(s.hooks.PostToolUse, [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: HOOK.command }] }]);
  assert.match(read(project, '.claude/settings.json'), /^\{\n\t"model"/);
  assert.ok(read(project, '.claude/settings.json').includes('$CLAUDE_PROJECT_DIR'), 'variable is not expanded');
  const m = JSON.parse(read(project, '.claude/ai-sdlc.manifest.json'));
  assert.strictEqual(m.hooks.length, 2);
});

test('uninstall removes exactly the hooks that were added and restores settings.json byte-for-byte', async () => {
  const original = '{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}';
  const project = newProject({ '.claude/settings.json': original });
  await install(project, writeBundle(tmpDir(), withHooks([HOOK, HOOK2])));
  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  assert.strictEqual(read(project, '.claude/settings.json'), original);
});

test('uninstall keeps settings the user added after install', async () => {
  const project = newProject({ '.claude/settings.json': '{\n  "a": 1\n}\n' });
  await install(project, writeBundle(tmpDir(), withHooks([HOOK])));
  const s = settingsOf(project);
  s.b = 2;
  fs.writeFileSync(path.join(project, '.claude/settings.json'), `${JSON.stringify(s, null, 2)}\n`);
  await runCli(['uninstall', '--project', project, '--yes']);
  assert.deepStrictEqual(settingsOf(project), { a: 1, b: 2 });
});

test('a settings.json created by the install is deleted on uninstall when it is empty again', async () => {
  const project = newProject();
  await install(project, writeBundle(tmpDir(), withHooks([HOOK])));
  assert.ok(exists(project, '.claude/settings.json'));
  await runCli(['uninstall', '--project', project, '--yes']);
  assert.ok(!exists(project, '.claude'));
});

test('update swaps hooks: old tagged entries go, new ones arrive, user entries stay', async () => {
  const project = newProject({ '.claude/settings.json': '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}' });
  const dir = tmpDir();
  await install(project, writeBundle(dir, withHooks([HOOK, HOOK2])));
  const changed = { event: 'PostToolUse', matcher: 'Write', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sync.js" --v2' };
  const r = await runCli(['update', '--project', project, '--from-bundle', writeBundle(dir, withHooks([changed], '1.1.0'), { name: 'b2.json' }), '--yes']);
  assert.strictEqual(r.code, 0, r.err);
  const s = settingsOf(project);
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
  assert.deepStrictEqual(s.hooks.PostToolUse, [{ matcher: 'Write', hooks: [{ type: 'command', command: changed.command }] }]);
  assert.strictEqual(JSON.parse(read(project, '.claude/ai-sdlc.manifest.json')).hooks.length, 1);
});

test('a hook entry the user already had is neither duplicated nor removed later', async () => {
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK2.command }] }] } };
  const text = JSON.stringify(mine);
  const project = newProject({ '.claude/settings.json': text });
  await install(project, writeBundle(tmpDir(), withHooks([HOOK2])));
  assert.strictEqual(settingsOf(project).hooks.Stop.length, 1);
  await runCli(['uninstall', '--project', project, '--yes']);
  assert.strictEqual(read(project, '.claude/settings.json'), text);
});

test('doctor reports unregistered hooks and a missing hook script', async () => {
  const project = newProject();
  await install(project, writeBundle(tmpDir(), withHooks([HOOK])));
  assert.strictEqual((await runCli(['doctor', '--project', project])).code, 0);
  fs.writeFileSync(path.join(project, '.claude/settings.json'), '{}\n');
  fs.rmSync(path.join(project, '.claude/hooks/sync.js'));
  const r = await runCli(['doctor', '--project', project]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /PostToolUse: not registered/);
  assert.match(r.out, /missing: \.claude\/hooks\/sync\.js/);
});
