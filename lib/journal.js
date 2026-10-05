'use strict';
const fs = require('fs');
const path = require('path');
const { CliError } = require('./errors');
const { JOURNAL_REL } = require('./path-rules');
const { resolveInside, writeAtomic, pruneEmptyDirs, assertRelPath } = require('./fs-safe');

// The journal doubles as the per-project run lock (created exclusively) and as
// the recovery record: before applying, it holds the previous content of every
// path the run will touch, so an interrupted run can be rolled back exactly.

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readJournal(abs) {
  try {
    const value = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

// entries: [{ path, before }] where before is base64 content or null (file did not exist).
function checkEntries(entries) {
  if (!Array.isArray(entries)) throw new CliError('the interrupted-run journal is unreadable; inspect it, delete it by hand, then re-run');
  for (const e of entries) {
    if (!e || typeof e.path !== 'string' || (e.before !== null && typeof e.before !== 'string')) {
      throw new CliError('the interrupted-run journal has a malformed entry; inspect it, delete it by hand, then re-run');
    }
    assertRelPath(e.path, 'journal path');
    if (e.path.toLowerCase().split('/').includes('.git')) throw new CliError('the interrupted-run journal points into .git; refusing to replay it');
  }
  return entries;
}

// Puts every entry back as it was, newest first. Returns a list of problems (empty when clean).
function rollbackEntries(project, entries) {
  const problems = [];
  for (const e of [...entries].reverse()) {
    try {
      const abs = resolveInside(project, e.path);
      if (e.before === null) {
        try {
          fs.rmSync(abs, { force: true });
        } catch (err) {
          if (err.code !== 'ENOTDIR') throw err; // a parent is a plain file, so nothing was ever created here
        }
        pruneEmptyDirs(project, path.dirname(abs));
      } else writeAtomic(abs, Buffer.from(e.before, 'base64'));
    } catch (err) {
      problems.push(`${e.path}: ${err.message}`);
    }
  }
  return problems;
}

function recoverStale(project, abs, force) {
  const journal = readJournal(abs);
  if (journal && pidAlive(journal.pid)) {
    throw new CliError(`another ai-sdlc run (pid ${journal.pid}) is in progress in this project; wait for it to finish`);
  }
  if (!force) {
    throw new CliError(`${JOURNAL_REL} found: an earlier run was interrupted. Run "ai-sdlc doctor", then retry with --force to roll its changes back`);
  }
  if (journal && journal.entries !== null && journal.entries !== undefined) {
    const problems = rollbackEntries(project, checkEntries(journal.entries));
    if (problems.length) throw new CliError(`rolling back the interrupted run failed: ${problems.join('; ')}`);
  }
  fs.rmSync(abs, { force: true });
}

// Takes the project lock for one mutating run. Throws if another run holds it,
// or if a stale journal exists and `force` is not set (with force it is rolled back first).
function acquireLock(project, op, { force = false } = {}) {
  const abs = resolveInside(project, JOURNAL_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let fd;
  for (let attempt = 0; attempt < 2 && fd === undefined; attempt += 1) {
    try {
      fd = fs.openSync(abs, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      recoverStale(project, abs, force);
    }
  }
  if (fd === undefined) throw new CliError('could not take the project lock; another run is starting at the same time');
  try {
    fs.writeSync(fd, `${JSON.stringify({ op, pid: process.pid, entries: null })}\n`);
  } finally {
    fs.closeSync(fd);
  }
  let kept = false;
  return {
    record(entries) {
      writeAtomic(abs, Buffer.from(`${JSON.stringify({ op, pid: process.pid, entries })}\n`));
    },
    // Leave the journal in place (a rollback failed and needs --force recovery).
    keep() {
      kept = true;
    },
    release() {
      if (kept) return;
      fs.rmSync(abs, { force: true });
      pruneEmptyDirs(project, path.dirname(abs));
    },
  };
}

module.exports = { acquireLock, rollbackEntries };
