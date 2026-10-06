'use strict';
// The guided install and update: banner, environment check, project, review,
// progress, result. The project is the current folder unless --project or --root
// says otherwise. Nothing touches the project until the review is confirmed; the
// apply layer is only called after that.
const { CliError, UsageError } = require('../../errors');
const { readManifest } = require('../../manifest');
const { compare } = require('../../semver');
const { loadReleaseBundle } = require('../../release-source');
const { githubChecks } = require('../../github-checks');
const { validateTarget } = require('../../project-picker');
const { buildCommandPlan, planSignature } = require('../../command-plan');
const { acquireLock } = require('../../journal');
const { applyPlan } = require('../../apply-plan');
const { inspect } = require('../../fs-safe');
const { JOURNAL_REL } = require('../../path-rules');
const { createTheme } = require('../theme');
const { withSession, Cancelled, BACK } = require('../terminal');
const { truncateMiddle } = require('../text-width');
const { sanitize } = require('../sanitize');
const { withSpinner } = require('../widgets/spinner');
const { createConfirm } = require('../widgets/confirm');
const { renderProgress } = require('../widgets/progress-bar');
const { runPreflight, statusLine } = require('./preflight');
const { bannerLines } = require('./intro');
const { sessionOptions } = require('./session-options');
const { pickProjectStep } = require('./pick-project-step');
const { reviewBody } = require('./review-view');
const { installedPanel, updatedPanel, upToDatePanel } = require('./result-views');
const { readRecent, rememberProject } = require('./recent-projects');
const { shortPath } = require('./project-choices');

const CHANGED_NOTE = 'The project changed after the plan was made; this is the updated plan.';
const COPY = {
  install: { confirm: 'Install', progress: 'Installing', pick: 'Select the project to install into' },
  update: { confirm: 'Update', progress: 'Updating', pick: 'Select the project to update' },
};

function preflightLines(theme, items) {
  return items.map((i) => {
    const mark = theme.sym[{ ok: 'ok', warn: 'warn', fail: 'err' }[i.status]];
    return `  ${theme.paint(theme.tone(i.status), mark)} ${sanitize(i.label)}  ${theme.paint('dim', sanitize(i.detail))}`;
  });
}

// The installed manifest of a folder, or null. A manifest that cannot be read counts as installed so planning reports why.
function installedManifest(dir) {
  try {
    return readManifest(dir);
  } catch (_) {
    return {};
  }
}

// The folder the user is standing in, when it can be the project. For update it must already hold an
// install (a subfolder of an installed repository gets the picker instead of a second, nested install).
function currentFolder(io, command) {
  let target;
  try {
    target = validateTarget(io.cwd, { cwd: io.cwd, home: io.home });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return { target: null, notice: err.message };
  }
  if (command === 'update' && !installedManifest(target.dir)) {
    return { target: null, notice: `ai-sdlc is not installed in ${target.dir}. Pick the project to update, or run "ai-sdlc init" here.` };
  }
  return { target, notice: '' };
}

async function wizard({ session, flags, io, cliVersion, command }) {
  const { theme } = session;
  const preflight = await withSpinner(session, 'Checking your environment...', (signal) => runPreflight({
    flags, cwd: io.cwd, execFile: io.execFile, env: io.env, signal, extraChecks: io.extraChecks || (flags.fromBundle ? [] : githubChecks(io.github)),
  }));
  session.commit([...bannerLines(session), `  ${theme.paint('dim', statusLine(theme, preflight.items))}`, '', ...preflightLines(theme, preflight.items), '']);

  // A failed token or access check ends the run here; the detail already names the way out (--from-bundle).
  const blocked = preflight.items.find((i) => i.status === 'fail' && /^github-/.test(i.id));
  if (blocked) throw new CliError(`${blocked.label}: ${blocked.detail}`);
  const bundle = await withSpinner(session, flags.fromBundle ? 'Reading the bundle...' : 'Downloading the kit release...', (signal) => loadReleaseBundle(
    { fromBundle: flags.fromBundle, version: flags.version, cwd: io.cwd, signal }, { fetchLatestBundle: io.fetchLatestBundle }, { cliVersion },
  ));
  for (const w of bundle.warnings) session.commit([`  ${theme.paint('warn', `${theme.sym.warn} ${sanitize(w)}`)}`]);

  const recents = readRecent({ env: io.env, home: io.home });
  // --project and the current folder are fixed targets: a problem with them ends the run instead of re-asking.
  const here = flags.project || flags.root ? { target: null, notice: '' } : currentFolder(io, command);
  const fixed = flags.project ? validateTarget(flags.project, { cwd: io.cwd, home: io.home }) : here.target;
  let notice = here.notice;
  for (;;) {
    const target = fixed || await pickProjectStep({ session, cwd: io.cwd, home: io.home, root: flags.root, recents, notice, title: COPY[command].pick });
    notice = '';
    if (target === BACK) throw new Cancelled('escape');
    if (command === 'update' && fixed && !installedManifest(target.dir)) {
      throw new CliError(`ai-sdlc is not installed in ${target.dir}; run "ai-sdlc init" to install it first`);
    }
    let planned;
    try {
      planned = buildCommandPlan({ command, flags, project: target.dir, bundle, cliVersion });
    } catch (err) {
      // For example "already installed": say so and let the user pick another project.
      if (fixed || !(err instanceof CliError)) throw err;
      notice = err.message;
      continue;
    }
    const { plan, prior } = planned;
    // The manifest is always rewritten; the same release with no other change is "nothing to do".
    const sameRelease = command === 'update' && prior && prior.payload_version === plan.payloadVersion;
    if (sameRelease && !plan.actions.some((a) => a.kind !== 'manifest' && (a.write || a.remove))) {
      const stale = inspect(target.dir, JOURNAL_REL).exists ? [`${JOURNAL_REL} exists: an earlier run was interrupted or another run is active`] : [];
      session.commit(upToDatePanel({ theme, width: session.ctx().width, project: shortPath(target.dir, io.home), version: bundle.version, warnings: stale }));
      return 0;
    }
    const fromVersion = command === 'update' && prior ? prior.payload_version : '';
    if ((await reviewAndApply({ session, flags, io, cliVersion, bundle, target, plan, command, fromVersion })) === BACK) {
      if (fixed) throw new Cancelled('escape');
      continue;
    }
    return 0;
  }
}

// Review loop: if the project no longer matches the reviewed plan once the lock is held, review again.
async function reviewAndApply({ session, flags, io, cliVersion, bundle, target, plan: first, command, fromVersion }) {
  let plan = first;
  const warnings = inspect(target.dir, JOURNAL_REL).exists ? [`${JOURNAL_REL} exists: an earlier run was interrupted or another run is active`] : [];
  if (fromVersion && compare(first.payloadVersion, fromVersion) === -1) warnings.push(`this release (${first.payloadVersion}) is older than the installed one (${fromVersion})`);
  for (;;) {
    const current = plan;
    const review = createConfirm({
      title: 'Review', confirmLabel: COPY[command].confirm, detailsToggle: true, guardMs: io.confirmGuardMs,
      body: (state, ctx) => reviewBody({ theme: ctx.theme, project: truncateMiddle(sanitize(shortPath(target.dir, io.home)), ctx.width - 30), plan: current, bundle, hasGit: target.hasGit, warnings, fromVersion }, state),
    });
    if ((await session.run(review)) === BACK) return BACK;
    const outcome = apply({ session, flags, io, cliVersion, bundle, project: target.dir, reviewed: current, command, fromVersion });
    if (!outcome.changed) return 0;
    plan = outcome.plan;
    if (!warnings.includes(CHANGED_NOTE)) warnings.push(CHANGED_NOTE);
  }
}

// Lock, plan again under the lock, apply with a progress bar, release.
// Returns { changed: true, plan } without writing when the fresh plan differs from the reviewed one.
function apply({ session, flags, io, cliVersion, bundle, project, reviewed, command, fromVersion }) {
  const lock = acquireLock(project, command, { force: Boolean(flags.force) });
  try {
    const { plan } = buildCommandPlan({ command, flags, project, bundle, cliVersion });
    if (planSignature(plan) !== planSignature(reviewed)) return { changed: true, plan };
    const shown = truncateMiddle(sanitize(shortPath(project, io.home)), session.ctx().width - 14);
    session.commit([`  ${session.theme.paint('ok', session.theme.sym.ok)} Project  ${session.theme.paint('dim', shown)}`]);
    const show = ({ done, total, path: rel }) => session.draw((ctx) => [
      '', `  ${COPY[command].progress} ai-sdlc ${sanitize(bundle.version)}`, renderProgress({ theme: ctx.theme, width: ctx.width, done, total, label: sanitize(rel || 'preparing') }),
    ]);
    applyPlan(project, plan, command, lock, { onProgress: show });
    rememberProject(project, { env: io.env, home: io.home });
    const panel = command === 'update' ? updatedPanel : installedPanel;
    session.commit(panel({ theme: session.theme, width: session.ctx().width, project: shortPath(project, io.home), plan, version: bundle.version, fromVersion }));
    return { changed: false };
  } finally {
    lock.release();
  }
}

async function runInitFlow({ flags, io, cliVersion, command = 'install' }) {
  const theme = createTheme({ env: io.env, stream: io.stdout });
  try {
    return await withSession(sessionOptions(io, theme), (session) => wizard({ session, flags, io, cliVersion, command }));
  } catch (err) {
    if (err instanceof Cancelled) throw new CliError(err.reason === 'interrupt' ? 'interrupted; nothing was changed' : 'cancelled; nothing was changed');
    throw err;
  }
}

module.exports = { runInitFlow };
