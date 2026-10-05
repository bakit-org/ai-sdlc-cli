'use strict';
// Environment checks shown before the project picker. Items are
// { id, status: 'ok' | 'warn' | 'fail', label, detail, segment? }.
const fs = require('fs');
const path = require('path');
const { execFile: nodeExecFile } = require('child_process');
const { sanitize } = require('../sanitize');

const MIN_NODE_MAJOR = 18;

function probeGit(execFile) {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : sanitize(String(stdout).trim().replace(/^git version\s*/i, '')).slice(0, 80));
    });
  });
}

function sourceItem(flags, cwd) {
  if (flags.fromBundle) {
    const file = path.resolve(cwd, flags.fromBundle);
    const found = fs.existsSync(file);
    return {
      id: 'source', status: found ? 'ok' : 'fail', label: 'Kit source: bundle file',
      detail: sanitize(found ? path.basename(file) : `not found: ${file}`), segment: found ? 'kit source: bundle file' : 'kit source: missing',
    };
  }
  return {
    id: 'source', status: 'fail', label: 'Kit source: release download',
    detail: 'release download unavailable in this build; pass --from-bundle <file>', segment: 'kit source: none',
  };
}

// `extraChecks` is the plug-in point for further checks (for example access to
// the release host). Each is an async (context) => item | null and runs after
// the built-in ones; an exception becomes a warning item instead of aborting.
async function runPreflight({ flags = {}, cwd = process.cwd(), nodeVersion = process.version, execFile = nodeExecFile, extraChecks = [] } = {}) {
  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  const git = await probeGit(execFile);
  const items = [
    { id: 'node', status: major >= MIN_NODE_MAJOR ? 'ok' : 'fail', label: 'Node.js', detail: `${nodeVersion} (needs >= ${MIN_NODE_MAJOR})`, segment: `node ${major}` },
    { id: 'git', status: git ? 'ok' : 'warn', label: 'git', detail: git || 'not found; only used to recognise repositories', segment: 'git' },
    sourceItem(flags, cwd),
  ];
  for (const check of extraChecks) {
    try {
      const item = await check({ flags, cwd });
      if (item) items.push(item);
    } catch (err) {
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
