'use strict';
const path = require('path');
const { UsageError } = require('./errors');

// Decides where the bundle comes from. Returns { bundlePath } or { bundleObject }.
// A later release will pass `fetchLatestBundle` (async, returns one of those
// shapes); until then only a local file is accepted.
async function resolveBundle(opts, { fetchLatestBundle } = {}) {
  if (opts.fromBundle) return { bundlePath: path.resolve(opts.cwd || process.cwd(), opts.fromBundle) };
  if (typeof fetchLatestBundle === 'function') return fetchLatestBundle(opts);
  throw new UsageError('downloading a release is not implemented yet; use --from-bundle <file>');
}

module.exports = { resolveBundle };
