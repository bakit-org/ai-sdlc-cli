'use strict';
const fs = require('fs');
const path = require('path');
const { resolveInside, writeAtomic, pruneEmptyDirs } = require('./fs-safe');
const { MANIFEST_REL } = require('./path-rules');
const { rollbackEntries } = require('./journal');
const { CliError } = require('./errors');

// Disk changes in execution order, the manifest always last.
function orderedChanges(plan) {
  const changes = plan.actions.filter((a) => a.write || a.remove);
  return [...changes.filter((a) => a.path !== MANIFEST_REL), ...changes.filter((a) => a.path === MANIFEST_REL)];
}

// Previous content of every path about to change (base64, or null when absent).
function beforeImages(project, changes) {
  return changes.map((a) => {
    const abs = resolveInside(project, a.path);
    return { path: a.path, before: fs.existsSync(abs) ? fs.readFileSync(abs).toString('base64') : null };
  });
}

// Executes the planned writes/removals while holding `lock`. The before-images
// go into the journal first, so a failure here (or a crash, recovered later with
// --force) can put every path back exactly as it was.
// `onProgress({ done, total, path })` (optional) is called before the first
// change and after each one; it has no influence on what is written.
function applyPlan(project, plan, op, lock, { onProgress } = {}) {
  const changes = orderedChanges(plan);
  const entries = beforeImages(project, changes);
  const report = (done, rel) => {
    if (!onProgress) return;
    try {
      onProgress({ done, total: changes.length, path: rel });
    } catch (_) {
      /* a display problem must not undo or abort the install */
    }
  };
  try {
    lock.record(entries);
    report(0, null);
    changes.forEach((a, i) => {
      const abs = resolveInside(project, a.path);
      if (a.write) writeAtomic(abs, a.write);
      else {
        fs.rmSync(abs, { force: true });
        pruneEmptyDirs(project, path.dirname(abs));
      }
      report(i + 1, a.path);
    });
  } catch (err) {
    const problems = rollbackEntries(project, entries);
    if (problems.length) {
      lock.keep();
      throw new CliError(`${op} failed: ${err.message} (rollback also failed: ${problems.join('; ')}; re-run with --force to retry the rollback)`);
    }
    throw new CliError(`${op} failed: ${err.message} (rolled back)`);
  }
}

module.exports = { applyPlan, orderedChanges, beforeImages };
