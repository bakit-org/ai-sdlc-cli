'use strict';
const { CliError } = require('./errors');
const { assertRelPath, inspect } = require('./fs-safe');
const { MANIFEST_REL, JOURNAL_REL, installPathProblem } = require('./path-rules');
const semver = require('./semver');

const MANIFEST_SCHEMA = 1;

function bad(why) {
  throw new CliError(`installed manifest ${MANIFEST_REL} is invalid: ${why}`);
}

function validate(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) bad('not an object');
  if (m.tool !== 'ai-sdlc-cli' || m.schema !== MANIFEST_SCHEMA) bad('unknown tool or schema');
  if (!semver.isStrict(m.payload_version)) bad('payload_version is missing or not a version');
  if (!Array.isArray(m.files)) bad('files missing');
  for (const f of m.files) {
    if (!f || (f.class !== 'managed' && f.class !== 'user-once') || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) bad('bad file entry');
    assertRelPath(f.path, 'manifest path');
    const why = installPathProblem(f.path, f.class);
    if (why) bad(`${f.path}: ${why}`);
  }
  if (!Array.isArray(m.hooks)) bad('hooks missing');
  for (const h of m.hooks) {
    if (!h || typeof h.event !== 'string' || typeof h.command !== 'string') bad('bad hook entry');
  }
  const b = m.block;
  if (b !== null && (!b || typeof b.created !== 'boolean' || typeof b.prefix !== 'string' || typeof b.eol !== 'string')) bad('bad block record');
  const s = m.settings;
  if (s !== null && (!s || typeof s.created !== 'boolean' || (s.original !== null && typeof s.original !== 'string'))) bad('bad settings record');
  return m;
}

// Returns null when the project has no manifest.
function readManifest(project) {
  const f = inspect(project, MANIFEST_REL);
  if (!f.exists) return null;
  let parsed;
  try {
    parsed = JSON.parse(f.bytes.toString('utf8'));
  } catch (err) {
    bad(`not JSON (${err.message})`);
  }
  return validate(parsed);
}

function buildManifest({ cliVersion, payloadVersion, payloadSchema, files, block, hooks, settings }) {
  return {
    tool: 'ai-sdlc-cli',
    schema: MANIFEST_SCHEMA,
    cli_version: cliVersion,
    payload_version: payloadVersion,
    payload_schema: payloadSchema,
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
    block: block || null,
    hooks,
    settings: settings || null,
  };
}

const serializeManifest = (m) => Buffer.from(`${JSON.stringify(m, null, 2)}\n`, 'utf8');

module.exports = { MANIFEST_REL, JOURNAL_REL, readManifest, buildManifest, serializeManifest };
