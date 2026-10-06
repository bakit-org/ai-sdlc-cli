'use strict';
// End to end: a bundle built from the real payload repo installs the requirements hook into a
// project's .claude/settings.json, the registered command behaves, and uninstall restores settings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir, newProject, runCli, read, exists } = require('./helpers');

const KIT = path.resolve(__dirname, '..', '..', 'ai-sdlc-kit');
const available = fs.existsSync(path.join(KIT, 'scripts', 'build-release.js'));
const skip = (!available && 'ai-sdlc-kit not found beside this repo') || (process.platform === 'win32' && 'needs a POSIX shell');

const EPIC = '.agent-artifacts/requirements/output/epic-01-focus-expedition';
const THIN_SIGNED_OFF = `---
type: Requirement Story
epic: "Epic 01 - Focus Expedition MVP"
status: signed-off
---

# \`us-009\` - \`Thin story\`

As a worker, I want to see a thing so that I can act

### Acceptance Criteria

**AC 1**: Only nominal path

\`\`\`gherkin
Given a thing
When the worker looks
Then the screen displays "Here is the thing"
\`\`\`
`;

function buildAndWriteBundle() {
  const { buildBundle } = require(path.join(KIT, 'scripts', 'build-release.js'));
  const b = buildBundle(KIT);
  const file = path.join(tmpDir(), b.name);
  fs.writeFileSync(file, b.json);
  fs.writeFileSync(`${file}.sha256`, `${b.digest}  ${b.name}\n`);
  return file;
}

// Runs a registered hook command the way Claude Code does: through a shell with CLAUDE_PROJECT_DIR set.
function runRegistered(command, project, filePath) {
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: project, tool_input: { file_path: filePath } });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: project };
  delete env.AI_SDLC_SKIP_HOOKS;
  return spawnSync('sh', ['-c', command], { input, env, cwd: project, encoding: 'utf8' });
}

const fixtureFiles = () => {
  const root = path.join(KIT, 'tests', 'fixtures', 'project');
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p);
    }
  };
  walk(root);
  return out;
};

// Existing settings with 4-space indent, CRLF-free, and an unrelated hook that must survive.
const USER_SETTINGS = `${JSON.stringify({ model: 'sonnet', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }, null, 4)}\n`;

test('install registers the hook, the command works, uninstall restores settings.json byte for byte', { skip }, async () => {
  const bundle = buildAndWriteBundle();
  const project = newProject({ '.claude/settings.json': USER_SETTINGS });
  for (const [rel, buf] of Object.entries(fixtureFiles())) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), buf);
  }
  const before = read(project, '.claude/settings.json');

  const inst = await runCli(['install', '--project', project, '--from-bundle', bundle, '--yes']);
  assert.strictEqual(inst.code, 0, inst.err);
  assert.ok(exists(project, '.claude/hooks/post-write-requirements.js'));

  const settings = JSON.parse(read(project, '.claude/settings.json'));
  assert.strictEqual(settings.model, 'sonnet');
  const entries = settings.hooks.PostToolUse;
  assert.ok(entries.some((e) => e.matcher === 'Bash' && e.hooks[0].command === 'echo user-hook'), 'user hook kept');
  const ours = entries.find((e) => e.matcher === 'Write|Edit|MultiEdit');
  assert.ok(ours, 'requirements hook registered');
  assert.deepStrictEqual(ours.hooks.map((h) => h.type), ['command']);
  const command = ours.hooks[0].command;
  assert.match(command, /\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/post-write-requirements\.js/);

  // A new story gets indexed with no manual command.
  const story = path.join(project, EPIC, 'us-008-new-story.md');
  fs.writeFileSync(story, THIN_SIGNED_OFF.replace('signed-off', 'draft'));
  const synced = runRegistered(command, project, story);
  assert.strictEqual(synced.status, 0, synced.stderr);
  assert.match(read(project, `${EPIC}/epic.md`), /\(us-008-new-story\.md\)/);

  // A signed-off story that fails the Definition of Ready is reported back with exit 2.
  fs.writeFileSync(story, THIN_SIGNED_OFF);
  const gated = runRegistered(command, project, story);
  assert.strictEqual(gated.status, 2);
  assert.match(gated.stderr, /status: signed-off/);
  assert.match(gated.stderr, /3-tier AC layering/);

  // Unrelated files are ignored.
  fs.writeFileSync(path.join(project, 'notes.md'), '# notes\n');
  const quiet = runRegistered(command, project, path.join(project, 'notes.md'));
  assert.deepStrictEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', '']);

  const doc = await runCli(['doctor', '--project', project, '--from-bundle', bundle]);
  assert.strictEqual(doc.code, 0, doc.out);

  const un = await runCli(['uninstall', '--project', project, '--yes']);
  assert.strictEqual(un.code, 0, un.err);
  assert.strictEqual(read(project, '.claude/settings.json'), before);
  assert.ok(!exists(project, '.claude/hooks/post-write-requirements.js'));
});

test('without prior settings the file is created on install and removed on uninstall', { skip }, async () => {
  const bundle = buildAndWriteBundle();
  const project = newProject({});
  assert.strictEqual((await runCli(['install', '--project', project, '--from-bundle', bundle, '--yes'])).code, 0);
  const hooks = JSON.parse(read(project, '.claude/settings.json')).hooks.PostToolUse;
  assert.strictEqual(hooks.length, 1);
  assert.strictEqual(hooks[0].matcher, 'Write|Edit|MultiEdit');
  assert.strictEqual((await runCli(['uninstall', '--project', project, '--yes'])).code, 0);
  assert.ok(!exists(project, '.claude/settings.json'));
});
