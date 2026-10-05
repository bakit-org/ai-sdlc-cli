'use strict';
const fs = require('fs');
const path = require('path');
const { CliError } = require('./errors');
const { sha256, assertRelPath } = require('./fs-safe');
const semver = require('./semver');
const { installPathProblem } = require('./path-rules');
const { BEGIN, END } = require('./merge-claude-md');

const SUPPORTED_SCHEMA = 1;
const CLASSES = new Set(['managed', 'block', 'user-once']);
const ENCODINGS = new Set(['utf8', 'base64']);

function fail(msg) {
  throw new CliError(`invalid bundle: ${msg}`);
}

// Compares the bundle file against the "<hex>  <name>" sidecar next to it.
function verifySidecar(file, bytes, warnings) {
  const sidecar = `${file}.sha256`;
  if (!fs.existsSync(sidecar)) {
    warnings.push(`no checksum file beside the bundle (${path.basename(sidecar)}); integrity not verified`);
    return;
  }
  const expected = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{64}$/i.test(expected)) fail(`checksum file ${path.basename(sidecar)} is malformed`);
  if (expected.toLowerCase() !== sha256(bytes)) {
    throw new CliError(`bundle checksum mismatch for ${path.basename(file)}: the file or its .sha256 was altered`);
  }
}

function readSource(source, warnings) {
  if (source.bundleObject) return source.bundleObject;
  let bytes;
  try {
    bytes = fs.readFileSync(source.bundlePath);
  } catch (err) {
    throw new CliError(`cannot read bundle ${source.bundlePath}: ${err.code || err.message}`);
  }
  verifySidecar(source.bundlePath, bytes, warnings);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    return fail(`not valid JSON (${err.message})`);
  }
}

function checkHeader(manifest, cliVersion) {
  if (!manifest || typeof manifest !== 'object') fail('missing manifest');
  if (manifest.payload_schema !== SUPPORTED_SCHEMA) {
    fail(`payload_schema ${manifest.payload_schema} is not supported (this CLI reads ${SUPPORTED_SCHEMA})`);
  }
  if (!semver.isStrict(manifest.version)) fail('manifest.version is not a version');
  const cmp = semver.compare(cliVersion, manifest.min_cli_version);
  if (cmp === null) fail('manifest.min_cli_version is not a version');
  if (cmp < 0) {
    throw new CliError(`this payload needs ai-sdlc-cli >= ${manifest.min_cli_version}, but this is ${cliVersion}; upgrade the CLI first`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('manifest.files is empty');
}

function decodeFiles(manifest, contents) {
  const seen = new Set();
  const files = manifest.files.map((f) => {
    if (!f || typeof f !== 'object') fail('manifest.files has a non-object entry');
    assertRelPath(f.path, 'bundle path');
    if (seen.has(f.path)) fail(`duplicate path ${f.path}`);
    seen.add(f.path);
    if (!CLASSES.has(f.class)) fail(`${f.path}: unknown class "${f.class}"`);
    if (!ENCODINGS.has(f.encoding)) fail(`${f.path}: unknown encoding "${f.encoding}"`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) fail(`${f.path}: bad sha256`);
    if (typeof contents[f.path] !== 'string') fail(`${f.path}: no content in bundle`);
    const why = installPathProblem(f.path, f.class);
    if (why) fail(`${f.path}: ${why}`);
    const bytes = Buffer.from(contents[f.path], f.encoding);
    if (sha256(bytes) !== f.sha256) throw new CliError(`bundle file hash mismatch: ${f.path}`);
    if (f.class === 'block' && f.encoding !== 'utf8') fail('the CLAUDE.md block must be utf8');
    return { path: f.path, class: f.class, sha256: f.sha256, encoding: f.encoding, bytes };
  });
  const extra = Object.keys(contents).filter((p) => !seen.has(p));
  if (extra.length) fail(`contents has files not listed in the manifest: ${extra[0]}`);
  return files;
}

function checkHooks(hooks) {
  if (hooks === undefined) return [];
  if (!Array.isArray(hooks)) fail('manifest.hooks must be an array');
  return hooks.map((h) => {
    if (!h || typeof h.event !== 'string' || !h.event || typeof h.command !== 'string' || !h.command) {
      fail('each hook needs a non-empty event and command');
    }
    if (h.matcher !== undefined && typeof h.matcher !== 'string') fail('hook matcher must be a string');
    return h.matcher === undefined ? { event: h.event, command: h.command } : { event: h.event, matcher: h.matcher, command: h.command };
  });
}

// source: { bundlePath } or { bundleObject }. Returns a verified, decoded bundle.
function loadBundle(source, { cliVersion }) {
  const warnings = [];
  const raw = readSource(source, warnings);
  if (!raw || typeof raw !== 'object' || !raw.manifest || !raw.contents || typeof raw.contents !== 'object') {
    fail('expected { manifest, contents }');
  }
  checkHeader(raw.manifest, cliVersion);
  const files = decodeFiles(raw.manifest, raw.contents);
  const hooks = checkHooks(raw.manifest.hooks);
  const blockFile = files.find((f) => f.class === 'block');
  const body = blockFile ? blockFile.bytes.toString('utf8') : '';
  if (body.includes(BEGIN) || body.includes(END)) fail('the CLAUDE.md block body must not contain the ai-sdlc begin/end markers');
  return {
    version: raw.manifest.version,
    payloadSchema: raw.manifest.payload_schema,
    files: files.filter((f) => f.class !== 'block'),
    block: blockFile ? { sha256: blockFile.sha256, body } : null,
    hooks,
    warnings,
  };
}

module.exports = { loadBundle, SUPPORTED_SCHEMA };
