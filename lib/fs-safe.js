'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CliError } = require('./errors');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Install paths arrive from a downloaded bundle or a manifest, so they are
// treated as hostile: relative, forward-slash, no dot segments.
function assertRelPath(rel, what = 'path') {
  const bad = (why) => {
    throw new CliError(`unsafe ${what} "${String(rel)}": ${why}`);
  };
  if (typeof rel !== 'string' || rel === '') bad('empty');
  if (rel.includes('\0')) bad('contains a NUL byte');
  if (rel.includes('\\')) bad('contains a backslash');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) bad('is absolute');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') bad('has an empty, "." or ".." segment');
  }
  return rel;
}

function isInside(root, target) {
  const r = path.relative(root, target);
  return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
}

// Resolves rel under root and proves, through symlinks, that the result stays
// inside root. `root` must already be a real path.
function resolveInside(root, rel) {
  assertRelPath(rel);
  const abs = path.join(root, ...rel.split('/'));
  if (!isInside(root, abs)) throw new CliError(`"${rel}" resolves outside the project`);
  let probe = abs;
  for (;;) {
    try {
      fs.lstatSync(probe);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch (err) {
    throw new CliError(`cannot resolve "${rel}": ${err.code || err.message}`);
  }
  if (real !== root && !isInside(root, real)) {
    throw new CliError(`"${rel}" resolves outside the project through a symlink`);
  }
  return abs;
}

// Reads one project file without following symlinks.
function inspect(root, rel) {
  const abs = resolveInside(root, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { abs, exists: false, bytes: null, hash: null };
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new CliError(
      `${rel} is a symlink and ai-sdlc will not write through it. Replace it with a regular file holding the same content, or run against the directory that contains the real file.`,
    );
  }
  if (!st.isFile()) throw new CliError(`expected a regular file at ${rel}`);
  const bytes = fs.readFileSync(abs);
  return { abs, exists: true, bytes, hash: sha256(bytes) };
}

// Text of an inspected file, or null when absent. Files that do not survive a
// UTF-8 round trip are refused so that rewriting them can never corrupt bytes.
function utf8Text(file, rel) {
  if (!file.exists) return null;
  const text = file.bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(file.bytes)) {
    throw new CliError(`${rel} is not valid UTF-8; ai-sdlc will not rewrite it. Nothing was changed.`);
  }
  return text;
}

// Replaces abs through a temporary file; an existing file keeps its permission bits.
function writeAtomic(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    let mode = null;
    try {
      mode = fs.statSync(abs).mode & 0o7777;
    } catch (_) {
      /* new file: default mode */
    }
    fs.writeFileSync(tmp, data);
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Removes now-empty directories above `start`, never the project root itself
// and never a symlink (a linked .claude is the user's to keep).
function pruneEmptyDirs(root, start) {
  let dir = start;
  while (isInside(root, dir)) {
    let entries;
    try {
      if (!fs.lstatSync(dir).isDirectory()) return;
      entries = fs.readdirSync(dir);
    } catch (_) {
      return;
    }
    if (entries.length) return;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function realProject(dir) {
  return fs.realpathSync(dir);
}

module.exports = { sha256, assertRelPath, isInside, resolveInside, inspect, utf8Text, writeAtomic, pruneEmptyDirs, realProject };
