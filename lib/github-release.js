'use strict';
// Reads release bundles from the payload repository over the GitHub REST API
// using the user's own credentials. Only Node's built-in fetch is used.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliError, UsageError } = require('./errors');
const { payloadRepo, apiBase, isDefaultApiBase } = require('./config');
const { resolveToken, redact, NO_TOKEN_MESSAGE, customBaseMessage } = require('./github-auth');
const { onTermination } = require('./termination-cleanup');
const { request } = require('./github-http');
const { failureFor } = require('./github-errors');
const semver = require('./semver');

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const OCTET = 'application/octet-stream';

const stripV = (tag) => String(tag).replace(/^v/, '');

// Candidate release tags for a requested version: as typed, then with/without the leading "v".
function tagCandidates(version) {
  const v = String(version).trim();
  if (!semver.isReleaseTag(v)) throw new UsageError('--version must be a release version such as 1.2.0 or v1.2.0');
  return [v, v.startsWith('v') ? v.slice(1) : `v${v}`];
}

// deps: { env, runCommand, fetchImpl, proc, releaseOptions: { timeoutMs, retries, backoffMs, tmpDir } }
// Every method takes an optional { signal } (AbortSignal): aborting stops requests, backoff waits and child processes.
function createGithubClient(deps = {}) {
  const env = deps.env || process.env;
  const proc = deps.proc || process;
  const tuning = deps.releaseOptions || {};
  let session = null;

  // Token and endpoint, resolved once. Throws CliError when no credentials exist.
  async function load(signal) {
    if (!session) {
      const repo = payloadRepo(env);
      const base = apiBase(env);
      const found = await resolveToken({ env, runCommand: deps.runCommand, signal, explicitOnly: !isDefaultApiBase(base) });
      session = { repo, base, token: found ? found.token : null, source: found ? found.source : null };
    }
    return session;
  }

  async function connect(signal) {
    const s = await load(signal);
    if (!s.token) throw new CliError(isDefaultApiBase(s.base) ? NO_TOKEN_MESSAGE : customBaseMessage(s.base));
    return s;
  }

  async function call(urlPath, { accept, maxBytes, notFound, signal } = {}) {
    const s = await connect(signal);
    let res;
    try {
      res = await request(`${s.base}${urlPath}`, {
        token: s.token, apiBase: s.base, accept, maxBytes, signal, fetchImpl: deps.fetchImpl, ...tuning,
      });
    } catch (err) {
      if (signal && signal.aborted) throw signal.reason;
      // Whatever went wrong, the token must not travel with the message.
      throw new CliError(redact(err.message, s.token), err instanceof CliError ? err.exitCode : 1);
    }
    if (res.status === 200) return res.body;
    throw failureFor(res, { repo: s.repo, source: s.source, notFound });
  }

  const json = (buf, what) => {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new CliError(`GitHub sent an unreadable ${what}`);
    }
  };

  async function checkAccess({ signal } = {}) {
    const s = await connect(signal);
    await call(`/repos/${s.repo}`, { signal });
    return { repo: s.repo, source: s.source };
  }

  // The release for `version` (a tag) or the latest one.
  async function findRelease(version, { signal } = {}) {
    const tags = version ? tagCandidates(version) : [];
    const s = await connect(signal);
    const missing = (what) => `${what} in ${s.repo}`;
    if (!version) {
      return json(await call(`/repos/${s.repo}/releases/latest`, { signal, notFound: missing('no release has been published') }), 'release');
    }
    for (let i = 0; i < tags.length; i += 1) {
      try {
        return json(await call(`/repos/${s.repo}/releases/tags/${encodeURIComponent(tags[i])}`, { signal, notFound: missing(`release ${version} was not found`) }), 'release');
      } catch (err) {
        if (i === tags.length - 1 || err.kind !== 'not-found') throw err;
      }
    }
    return null;
  }

  function pickAssets(release, repo) {
    const tag = release && typeof release.tag_name === 'string' ? release.tag_name : '';
    const assets = release && Array.isArray(release.assets) ? release.assets.filter((a) => a && SAFE_NAME.test(a.name || '') && Number.isInteger(a.id)) : [];
    const bundles = assets.filter((a) => /^ai-sdlc-.+\.bundle\.json$/.test(a.name));
    const bundle = bundles.find((a) => a.name === `ai-sdlc-${stripV(tag)}.bundle.json`) || (bundles.length === 1 ? bundles[0] : null);
    if (!tag || !bundle) throw new CliError(`release ${tag || '(unnamed)'} in ${repo} has no bundle asset (expected ai-sdlc-<version>.bundle.json)`);
    const sidecar = assets.find((a) => a.name === `${bundle.name}.sha256`);
    if (!sidecar) throw new CliError(`release ${tag} in ${repo} has no checksum asset (${bundle.name}.sha256); refusing to install unverified`);
    return { tag, bundle, sidecar };
  }

  // Downloads bundle + checksum into a private temp directory. Returns { bundlePath, version, cleanup }.
  // The directory is also removed if the process is stopped with SIGINT/SIGTERM before cleanup() runs.
  async function downloadBundle(version, { signal } = {}) {
    const s = await connect(signal);
    const release = await findRelease(version, { signal });
    const { tag, bundle, sidecar } = pickAssets(release, s.repo);
    const asset = (a, maxBytes) => call(`/repos/${s.repo}/releases/assets/${a.id}`, { signal, accept: OCTET, maxBytes, notFound: `release asset ${a.name} could not be downloaded` });
    const dir = fs.mkdtempSync(path.join(tuning.tmpDir || os.tmpdir(), 'ai-sdlc-dl-'));
    const remove = () => fs.rmSync(dir, { recursive: true, force: true });
    const off = onTermination(proc, remove);
    const cleanup = () => {
      off();
      remove();
    };
    try {
      const bundlePath = path.join(dir, bundle.name);
      fs.writeFileSync(bundlePath, await asset(bundle, MAX_BUNDLE_BYTES), { mode: 0o600 });
      fs.writeFileSync(`${bundlePath}.sha256`, await asset(sidecar, 4096), { mode: 0o600 });
      return { bundlePath, version: stripV(tag), cleanup };
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  // Where the credentials came from (never the value) and which repo/base is used; source is null when none were found.
  async function describe({ signal } = {}) {
    const s = await load(signal);
    return { repo: s.repo, base: s.base, defaultBase: isDefaultApiBase(s.base), source: s.source };
  }

  return { checkAccess, findRelease, downloadBundle, describe };
}

// The `fetchLatestBundle` plug for release-source.js.
const createReleaseFetcher = (deps) => {
  const client = deps.client || createGithubClient(deps);
  return async (opts = {}) => {
    if (opts.version) tagCandidates(opts.version);
    await client.checkAccess({ signal: opts.signal });
    return client.downloadBundle(opts.version, { signal: opts.signal });
  };
};

module.exports = { createGithubClient, createReleaseFetcher, stripV, tagCandidates };
