'use strict';
// Environment checks shown before the project picker. Items are
// { id, status: 'ok' | 'warn' | 'fail', label, detail, segment? }.
const fs = require('fs');
const path = require('path');
const { execFile: nodeExecFile } = require('child_process');
const { sanitize } = require('../sanitize');
const { payloadRepo, apiBase, isDefaultApiBase } = require('../../config');

const MIN_NODE_MAJOR = 18;

function probeGit(execFile, signal) {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 4000, windowsHide: true, signal }, (err, stdout) => {
      resolve(err ? null : sanitize(String(stdout).trim().replace(/^git version\s*/i, '')).slice(0, 80));
    });
  });
}

// "owner/repo", plus the API base when it is not the public GitHub API (so it is never a surprise).
function releaseSource(env) {
  try {
    const repo = payloadRepo(env);
    const base = apiBase(env);
    return { repo, custom: !isDefaultApiBase(base), text: isDefaultApiBase(base) ? repo : `${repo} via ${base}` };
  } catch (err) {
    return { custom: false, text: err.message };
  }
}

function sourceItem(flags, cwd, env) {
  if (flags.fromBundle) {
    const file = path.resolve(cwd, flags.fromBundle);
    const found = fs.existsSync(file);
    return {
      id: 'source', status: found ? 'ok' : 'fail', label: 'Kit source: bundle file',
      detail: sanitize(found ? path.basename(file) : `not found: ${file}`), segment: found ? 'kit source: bundle file' : 'kit source: missing',
    };
  }
  const src = releaseSource(env);
  return {
    id: 'source', status: 'ok', label: 'Kit source: GitHub release',
    detail: sanitize(src.text), segment: src.custom ? 'kit source: GitHub release (custom API)' : 'kit source: GitHub release',
  };
}

// `extraChecks` is the plug-in point for further checks (the wizard adds the GitHub
// token and repository access checks when no local bundle is given). Each is an async (context) => item | null and runs after
// the built-in ones; an exception becomes a warning item instead of aborting.
async function runPreflight({ flags = {}, cwd = process.cwd(), nodeVersion = process.version, execFile = nodeExecFile, extraChecks = [], env = process.env, signal } = {}) {
  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  const git = await probeGit(execFile, signal);
  const items = [
    { id: 'node', status: major >= MIN_NODE_MAJOR ? 'ok' : 'fail', label: 'Node.js', detail: `${nodeVersion} (needs >= ${MIN_NODE_MAJOR})`, segment: `node ${major}` },
    { id: 'git', status: git ? 'ok' : 'warn', label: 'git', detail: git || 'not found; only used to recognise repositories', segment: 'git' },
    sourceItem(flags, cwd, env),
  ];
  for (const check of extraChecks) {
    try {
      const item = await check({ flags, cwd, signal });
      if (item) items.push(item);
    } catch (err) {
      if (signal && signal.aborted) throw signal.reason;
      items.push({ id: 'extra', status: 'warn', label: 'Additional check', detail: sanitize(err.message) });
    }
  }
  return { items };
}

// "Using: node 24 | git ✔ | kit source: bundle file"
function statusLine(theme, items) {
  const parts = items.filter((i) => i.segment).map((i) => {
    if (i.id !== 'node' && i.id !== 'git' && i.id !== 'source') return sanitize(i.segment);
    if (i.id === 'git') return `git ${i.status === 'ok' ? theme.sym.ok : theme.sym.warn}`;
    return i.segment;
  });
  return `Using: ${parts.join(' | ')}`;
}

module.exports = { runPreflight, statusLine, MIN_NODE_MAJOR };
