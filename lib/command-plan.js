'use strict';
const crypto = require('crypto');
const { CliError } = require('./errors');
const { readManifest } = require('./manifest');
const { planSync, planRemove } = require('./plan');

// Reads the installed manifest, applies the install/update/uninstall
// preconditions and plans the run. Read-only: nothing is written.
function buildCommandPlan({ command, flags, project, bundle, cliVersion }) {
  const prior = readManifest(project);
  if (command === 'install' && prior && !flags.force) {
    throw new CliError(`already installed (payload ${prior.payload_version}); use "ai-sdlc update", or --force to reinstall`);
  }
  if (command !== 'install' && !prior) throw new CliError(`ai-sdlc is not installed in ${project}`);
  const plan = command === 'uninstall'
    ? planRemove({ project, prior })
    : planSync({ project, bundle, prior, force: flags.force, cliVersion, op: command });
  return { prior, plan };
}

// Stable fingerprint of what a plan would do (actions, paths and the bytes to write),
// to tell whether a plan made earlier still matches the project.
function planSignature(plan) {
  const rows = plan.actions.map((a) => [a.kind, a.action, a.path, a.detail, a.write ? crypto.createHash('sha256').update(a.write).digest('hex') : null, Boolean(a.remove)]);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

module.exports = { buildCommandPlan, planSignature };
