'use strict';
// Remembers project paths (and nothing else) between runs in a small JSON file
// under the user's config directory. Every failure is ignored: this is a
// convenience, never a reason for a run to fail.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_RECENT = 12;
const MAX_EXAMINED = 40; // entries checked on disk per read, so a dead path cannot stall startup

// XDG_CONFIG_HOME counts only when absolute, as the XDG specification says.
function configDir(env = process.env, home = os.homedir(), platform = process.platform) {
  if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, 'ai-sdlc');
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'ai-sdlc');
  return path.join(home, '.config', 'ai-sdlc');
}

const recentFile = (opts = {}) => path.join(configDir(opts.env, opts.home, opts.platform), 'recent.json');

function readList(opts) {
  const parsed = JSON.parse(fs.readFileSync(recentFile(opts), 'utf8'));
  return Array.isArray(parsed && parsed.projects) ? parsed.projects.filter((p) => typeof p === 'string' && path.isAbsolute(p)) : [];
}

// Absolute paths of remembered projects that still exist, newest first.
function readRecent(opts = {}) {
  try {
    const out = [];
    for (const p of readList(opts).slice(0, MAX_EXAMINED)) {
      try {
        if (fs.statSync(p).isDirectory()) out.push(p);
      } catch (_) {
        /* gone: skip */
      }
      if (out.length >= MAX_RECENT) break;
    }
    return out;
  } catch (_) {
    return [];
  }
}

// Private to the user: the folder is created 0700 and the file 0600 (no effect on Windows).
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Puts `dir` first in the list. Returns true when the file was written.
function rememberProject(dir, opts = {}) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
    let current = [];
    try {
      current = readList(opts);
    } catch (_) {
      /* no file yet, or unreadable: start a new list */
    }
    const projects = [dir, ...current.filter((p) => p !== dir)].slice(0, MAX_RECENT);
    writePrivate(recentFile(opts), `${JSON.stringify({ projects }, null, 2)}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { configDir, recentFile, readRecent, rememberProject };
