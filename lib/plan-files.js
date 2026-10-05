'use strict';
const { inspect } = require('./fs-safe');

// An action is a plain record. `write` (Buffer) / `remove` make it a disk
// change; everything else is information only. Apply never decides anything.
function act(kind, action, rel, detail, extra) {
  return { kind, action, path: rel, detail: detail || '', ...extra };
}

// Three-way comparison for payload files:
//   old = hash recorded at last install, disk = what is there now, new = bundle.
// `reinstall` is true for install (even over a manifest) and false for update.
// Returns { actions, tracked } where tracked is the file list for the next manifest.
function planFiles({ project, bundle, prior, force, reinstall }) {
  const actions = [];
  const tracked = [];
  const priorByPath = new Map((prior ? prior.files : []).map((f) => [f.path, f]));
  const shipped = new Set(bundle.files.map((f) => f.path));

  for (const f of bundle.files) {
    const disk = inspect(project, f.path);
    const old = priorByPath.get(f.path);

    if (f.class === 'user-once') {
      tracked.push({ path: f.path, sha256: f.sha256, class: 'user-once' });
      if (disk.exists) actions.push(act('file', 'keep-existing', f.path, 'user-owned, never overwritten'));
      else if (old && old.class === 'user-once' && !reinstall) {
        // Tracked before and gone now: the user removed it, so an update must not bring it back.
        actions.push(act('file', 'skip-deleted', f.path, 'you deleted this starter file; not re-created'));
      } else actions.push(act('file', 'create', f.path, 'starter file', { write: f.bytes }));
      continue;
    }

    const recorded = old && old.class === 'managed' ? old.sha256 : null;
    const own = { path: f.path, sha256: f.sha256, class: 'managed' };
    if (!disk.exists) {
      tracked.push(own);
      actions.push(act('file', recorded ? 'restore' : 'create', f.path, '', { write: f.bytes }));
    } else if (disk.hash === f.sha256) {
      tracked.push(own);
      actions.push(act('file', 'unchanged', f.path));
    } else if (recorded && disk.hash === recorded) {
      tracked.push(own);
      actions.push(act('file', 'replace', f.path, 'new payload version', { write: f.bytes }));
    } else if (force) {
      tracked.push(own);
      actions.push(act('file', 'replace', f.path, 'overwritten (--force)', { write: f.bytes }));
    } else {
      // Locally modified (or a foreign file sits here): keep it, offer the new copy beside it.
      if (recorded) tracked.push({ path: f.path, sha256: recorded, class: 'managed' });
      actions.push(act('file', 'keep-modified', f.path, recorded ? 'locally modified' : 'a different file already exists'));
      if (f.sha256 !== recorded) {
        const newRel = `${f.path}.new`;
        inspect(project, newRel);
        actions.push(act('file', 'write-new', newRel, 'incoming version for manual merge', { write: f.bytes }));
      }
    }
  }

  for (const old of priorByPath.values()) {
    if (old.class !== 'managed' || shipped.has(old.path)) continue;
    const disk = inspect(project, old.path);
    if (!disk.exists) actions.push(act('file', 'forget', old.path, 'no longer shipped, already gone'));
    else if (disk.hash === old.sha256) actions.push(act('file', 'delete', old.path, 'no longer shipped', { remove: true }));
    else actions.push(act('file', 'keep-modified', old.path, 'no longer shipped but locally modified; now yours'));
  }
  return { actions, tracked };
}

// Uninstall counterpart: only unmodified managed files are deleted.
function planRemoveFiles({ project, prior }) {
  const actions = [];
  for (const f of prior.files) {
    if (f.class === 'user-once') {
      actions.push(act('file', 'keep-existing', f.path, 'user-owned, left in place'));
      continue;
    }
    const disk = inspect(project, f.path);
    if (!disk.exists) actions.push(act('file', 'forget', f.path, 'already gone'));
    else if (disk.hash === f.sha256) actions.push(act('file', 'delete', f.path, '', { remove: true }));
    else actions.push(act('file', 'keep-modified', f.path, 'locally modified, left in place'));
  }
  return actions;
}

module.exports = { act, planFiles, planRemoveFiles };
