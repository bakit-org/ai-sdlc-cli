'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const { run } = require('../lib/commands');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpDir(prefix = 'ai-sdlc-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A small bundle object: files = [{ path, class, text | base64 }].
function makeBundle({ version = '1.0.0', minCli = '0.1.0', schema = 1, files, hooks } = {}) {
  const list = files || [
    { path: '.claude/agents/alpha.md', class: 'managed', text: '# alpha v1\n' },
    { path: '.claude/skills/beta/SKILL.md', class: 'managed', text: '# beta v1\n' },
    { path: 'CLAUDE.md', class: 'block', text: '## ai-sdlc router\nUse the agents.\n' },
    { path: 'ai-sdlc/project.md', class: 'user-once', text: '# Project\n' },
  ];
  const manifestFiles = [];
  const contents = {};
  for (const f of list) {
    const bytes = f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : Buffer.from(f.text, 'utf8');
    manifestFiles.push({ path: f.path, sha256: sha(bytes), class: f.class, encoding: f.base64 !== undefined ? 'base64' : 'utf8' });
    contents[f.path] = f.base64 !== undefined ? f.base64 : f.text;
  }
  const manifest = { version, payload_schema: schema, min_cli_version: minCli, files: manifestFiles };
  if (hooks) manifest.hooks = hooks;
  return { manifest, contents };
}

// Writes the bundle (and optionally its sidecar) and returns the bundle path.
function writeBundle(dir, bundle, { sidecar = true, name = 'ai-sdlc-test.bundle.json' } = {}) {
  const file = path.join(dir, name);
  const json = `${JSON.stringify(bundle)}\n`;
  fs.writeFileSync(file, json);
  if (sidecar) fs.writeFileSync(`${file}.sha256`, `${sha(Buffer.from(json))}  ${name}\n`);
  return file;
}

function newProject(files = {}) {
  const dir = tmpDir('ai-sdlc-proj-');
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// Runs the CLI in-process with captured output. `stdin` is a string of scripted input.
async function runCli(args, { cwd, isTTY = false, stdin = '', home, ...inject } = {}) {
  const input = new PassThrough();
  if (stdin) input.write(stdin);
  input.end();
  const out = [];
  const err = [];
  const sink = (arr) => ({ write: (s) => arr.push(String(s)) });
  const code = await run(args, {
    cwd: cwd || process.cwd(), isTTY, stdin: input, stdout: sink(out), stderr: sink(err), home: home || tmpDir('ai-sdlc-home-'),
    probePython: () => null,
    ...inject,
  });
  return { code, out: out.join(''), err: err.join('') };
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// A process id that is certainly not running (a child that already exited).
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

// Injected environment in which no GitHub credentials exist anywhere (no env vars, no gh, no git helper).
const NO_CREDENTIALS = { env: {}, runCommand: async () => ({ code: null, stdout: '' }) };

module.exports = { NO_CREDENTIALS, deadPid, sha, tmpDir, makeBundle, writeBundle, newProject, runCli, read, exists, walk };
