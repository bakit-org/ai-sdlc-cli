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
function applyPlan(project, plan, op, lock) {
  const changes = orderedChanges(plan);
  const entries = beforeImages(project, changes);
  try {
    lock.record(entries);
    for (const a of changes) {
      const abs = resolveInside(project, a.path);
      if (a.write) writeAtomic(abs, a.write);
      else {
        fs.rmSync(abs, { force: true });
        pruneEmptyDirs(project, path.dirname(abs));
      }
    }
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
