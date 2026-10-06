'use strict';
const path = require('path');
const { CliError, UsageError } = require('./errors');
const { loadBundle } = require('./bundle');

// Decides where the bundle comes from. Returns { bundlePath } or { bundleObject },
// optionally with `cleanup()` for temporary files and `version` (the release's version).
// `fetchLatestBundle(opts)` downloads a release; `opts.version` pins a tag, `opts.signal` cancels it.
async function resolveBundle(opts, { fetchLatestBundle } = {}) {
  if (opts.fromBundle) return { bundlePath: path.resolve(opts.cwd || process.cwd(), opts.fromBundle) };
  if (typeof fetchLatestBundle === 'function') return fetchLatestBundle(opts);
  throw new UsageError('no release source is configured; use --from-bundle <file>');
}

// Resolve + load + verify, then remove any downloaded temporary file.
async function loadReleaseBundle(opts, deps, { cliVersion }) {
  const source = await resolveBundle(opts, deps);
  try {
    const bundle = loadBundle(source, { cliVersion });
    // A downloaded release must carry the payload version its tag announces.
    if (source.version && bundle.version !== source.version) {
      throw new CliError(`the release is tagged ${source.version} but its bundle contains payload ${bundle.version}; refusing to install (ask the repo owner to republish the release)`);
    }
    return bundle;
  } finally {
    if (typeof source.cleanup === 'function') source.cleanup();
  }
}

module.exports = { resolveBundle, loadReleaseBundle };
