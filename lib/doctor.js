'use strict';
const { spawnSync } = require('child_process');
const { inspect, utf8Text } = require('./fs-safe');
const { readManifest } = require('./manifest');
const { JOURNAL_REL, MANIFEST_REL } = require('./path-rules');
const { SETTINGS_REL, parseSettings, hasHook } = require('./merge-settings');
const { hasBlock } = require('./merge-claude-md');
const semver = require('./semver');

const MIN_NODE_MAJOR = 18;
// $CLAUDE_PROJECT_DIR/x, "$CLAUDE_PROJECT_DIR"/x and ${CLAUDE_PROJECT_DIR}/x, quoted or not.
const HOOK_SCRIPT = /(?:\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR)"?\/([^\s"'`;|&)]+)/g;

function defaultProbePython() {
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return (r.stdout || r.stderr).trim();
  }
  return null;
}

// Read-only health report. Never writes; checks are { name, status, detail }
// with status ok | warn | fail | info. A check that throws (symlink, permissions,
// bad encoding) becomes a fail entry instead of aborting the report.
function runDoctor({ project, nodeVersion, bundleVersion, probePython = defaultProbePython }) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const guard = (name, fn) => {
    try {
      fn();
    } catch (err) {
      add(name, 'fail', err.message);
    }
  };

  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  add('node', major >= MIN_NODE_MAJOR ? 'ok' : 'fail', `${nodeVersion} (needs >= ${MIN_NODE_MAJOR})`);

  guard('journal', () => {
    if (inspect(project, JOURNAL_REL).exists) {
      add('journal', 'fail', `${JOURNAL_REL} exists: a run is active or was interrupted; if no run is active, retry the command with --force to roll it back`);
    }
  });

  let manifest = null;
  guard('manifest', () => {
    manifest = readManifest(project);
    if (!manifest) add('manifest', 'fail', `${MANIFEST_REL} not found: ai-sdlc is not installed in ${project}`);
    else add('manifest', 'ok', `payload ${manifest.payload_version}, ${manifest.files.length} tracked file(s)`);
  });
  if (!manifest) return finish(checks);

  const managed = manifest.files.filter((f) => f.class === 'managed');
  let intact = 0;
  for (const f of managed) {
    guard('managed file', () => {
      const disk = inspect(project, f.path);
      if (!disk.exists) add('managed file', 'fail', `missing: ${f.path}`);
      else if (disk.hash !== f.sha256) add('managed file', 'warn', `modified locally: ${f.path}`);
      else intact += 1;
    });
  }
  add('managed files', intact === managed.length ? 'ok' : 'warn', `${intact}/${managed.length} intact`);

  guard('hooks', () => checkHooks(project, manifest, add));

  if (manifest.block) {
    guard('CLAUDE.md block', () => {
      const text = utf8Text(inspect(project, 'CLAUDE.md'), 'CLAUDE.md');
      const present = text !== null && hasBlock(text);
      add('CLAUDE.md block', present ? 'ok' : 'fail', present ? 'router block present' : 'router block missing from CLAUDE.md');
    });
  }

  const scaffolds = manifest.files.filter((f) => f.class === 'user-once');
  const lost = [];
  for (const f of scaffolds) {
    guard('scaffold', () => {
      if (!inspect(project, f.path).exists) lost.push(f.path);
    });
  }
  add('scaffolds', lost.length ? 'warn' : 'ok', lost.length ? `missing: ${lost.join(', ')}` : `${scaffolds.length} present`);

  if (bundleVersion) {
    const cmp = semver.compare(manifest.payload_version, bundleVersion);
    add('version', cmp === 0 ? 'ok' : 'warn', cmp === 0 ? `up to date (${bundleVersion})` : `installed ${manifest.payload_version}, bundle ${bundleVersion}: run update`);
  } else {
    add('version', 'info', `installed ${manifest.payload_version}; pass --from-bundle to compare with a bundle`);
  }

  if (managed.some((f) => f.path.endsWith('.py'))) {
    guard('python', () => {
      const found = probePython();
      add('python', found ? 'info' : 'warn', found ? `${found} (optional helper scripts)` : 'optional: some helper scripts need Python 3, which was not found');
    });
  }
  return finish(checks);
}

function checkHooks(project, manifest, add) {
  if (!manifest.hooks.length) return;
  const file = inspect(project, SETTINGS_REL);
  const settings = parseSettings(utf8Text(file, SETTINGS_REL));
  for (const h of manifest.hooks) {
    const registered = hasHook(settings, h);
    add('hook', registered ? 'ok' : 'fail', `${h.event}: ${registered ? 'registered' : 'not registered'} (${h.command})`);
    for (const m of h.command.matchAll(HOOK_SCRIPT)) {
      let present = false;
      try {
        present = inspect(project, m[1]).exists;
      } catch (_) {
        /* unsafe or unreadable path counts as missing */
      }
      if (!present) add('hook script', 'fail', `missing or unusable: ${m[1]}`);
    }
  }
}

function finish(checks) {
  return { checks, ok: !checks.some((c) => c.status === 'fail') };
}

module.exports = { runDoctor };
