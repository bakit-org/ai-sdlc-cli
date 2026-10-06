'use strict';
// `ai-sdlc version --check`: the CLI version, the latest payload release and,
// when a project is known, what is installed there.
const path = require('path');
const pkg = require('../package.json');
const { CliError } = require('./errors');
const { readManifest } = require('./manifest');
const semver = require('./semver');
const { stripV } = require('./github-release');

function installedVersion(flags, io) {
  if (flags.project) return readManifest(path.resolve(io.cwd, flags.project));
  try {
    return readManifest(io.cwd);
  } catch {
    return null;
  }
}

async function runVersionCheck(flags, io, say) {
  const { repo } = await io.github.checkAccess();
  const release = await io.github.findRelease();
  const latest = stripV(release && release.tag_name);
  if (!semver.isStrict(latest)) throw new CliError(`the latest release of ${repo} has an unusable tag`);
  const manifest = installedVersion(flags, io);
  const installed = manifest ? manifest.payload_version : null;
  const cmp = installed ? semver.compare(installed, latest) : null;
  const status = cmp === null ? null : cmp < 0 ? 'update-available' : 'up-to-date';
  if (flags.json) {
    say.stdout.write(`${JSON.stringify({ version: pkg.version, repo, latest, installed, status })}\n`);
    return 0;
  }
  say.stdout.write(`ai-sdlc-cli ${pkg.version}\nlatest payload release (${repo}): ${latest}\n`);
  if (installed) say.stdout.write(`installed payload: ${installed} (${status === 'update-available' ? 'run `ai-sdlc update` to upgrade' : 'up to date'})\n`);
  return 0;
}

module.exports = { runVersionCheck };
