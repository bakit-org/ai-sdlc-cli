'use strict';
// Candidate projects for the picker: remembered ones first, then repositories
// found next to the working directory (or under --root). Everything shown is
// data from disk, so it is sanitized before it reaches a widget.
const fs = require('fs');
const path = require('path');
const { findRepos } = require('../../project-picker');
const { readManifest } = require('../../manifest');
const { sanitize } = require('../sanitize');

const PATH_CHOICE = Symbol('enter-a-path');
const MAX_CANDIDATES = 200;

// { hasGit, version, invalid }: version is the installed payload version or null;
// invalid carries the reason when the manifest exists but cannot be trusted.
function projectState(dir) {
  const state = { hasGit: fs.existsSync(path.join(dir, '.git')), version: null, invalid: null };
  try {
    const m = readManifest(dir);
    state.version = m ? m.payload_version : null;
  } catch (err) {
    state.invalid = sanitize(err.message);
  }
  return state;
}

const shortPath = (dir, home) => (home && (dir === home || dir.startsWith(home + path.sep)) ? `~${dir.slice(home.length)}` : dir);

function badgeFor(state, theme) {
  if (!state.hasGit) return { badge: `no .git ${theme.sym.warn}`, tone: 'warn' };
  if (state.invalid) return { badge: `manifest invalid ${theme.sym.warn}`, tone: 'warn' };
  if (state.version) return { badge: `installed v${sanitize(state.version)} ${theme.sym.arrow} update`, tone: 'ok' };
  return { badge: 'not installed', tone: 'dim' };
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return p;
  }
}

// Volumes on Windows and macOS are usually case-insensitive: the same folder spelled twice is one folder.
const dedupeKey = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);

// Returns picker items ending with the sticky "Enter a path..." entry (at most MAX_CANDIDATES projects).
function buildProjectItems({ cwd, root, home, recents = [], theme }) {
  const bases = root ? [path.resolve(cwd, root)] : [cwd, path.dirname(cwd)];
  const seen = new Set();
  const items = [];
  for (const dir of [...recents, ...findRepos(bases, MAX_CANDIDATES)]) {
    if (items.length >= MAX_CANDIDATES) break;
    const real = realOrSelf(dir);
    const key = dedupeKey(real);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ label: path.basename(real) || real, hint: shortPath(real, home), value: real, ...badgeFor(projectState(real), theme) });
  }
  items.push({ label: `Enter a path${theme.sym.ellipsis}`, hint: '', value: PATH_CHOICE, sticky: true });
  return items;
}

module.exports = { buildProjectItems, projectState, shortPath, badgeFor, PATH_CHOICE, MAX_CANDIDATES };
