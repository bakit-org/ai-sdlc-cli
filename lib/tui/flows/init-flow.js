'use strict';
// The guided install: banner, environment check, project, review, progress, result.
// Nothing touches the project until the review is confirmed; the apply layer is
// only called after that.
const { CliError } = require('../../errors');
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
const { installedPanel } = require('./result-views');
const { readRecent, rememberProject } = require('./recent-projects');
const { shortPath } = require('./project-choices');

const CHANGED_NOTE = 'The project changed after the plan was made; this is the updated plan.';

function preflightLines(theme, items) {
  return items.map((i) => {
    const mark = theme.sym[{ ok: 'ok', warn: 'warn', fail: 'err' }[i.status]];
    return `  ${theme.paint(theme.tone(i.status), mark)} ${sanitize(i.label)}  ${theme.paint('dim', sanitize(i.detail))}`;
  });
}

async function wizard({ session, flags, io, cliVersion }) {
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
  let notice = '';
  for (;;) {
    const target = flags.project ? validateTarget(flags.project, { cwd: io.cwd, home: io.home }) : await pickProjectStep({ session, cwd: io.cwd, home: io.home, root: flags.root, recents, notice });
    notice = '';
    if (target === BACK) throw new Cancelled('escape');
    let plan;
    try {
      ({ plan } = buildCommandPlan({ command: 'install', flags, project: target.dir, bundle, cliVersion }));
    } catch (err) {
      // For example "already installed": say so and let the user pick another project.
      if (flags.project || !(err instanceof CliError)) throw err;
      notice = err.message;
      continue;
    }
    if ((await reviewAndInstall({ session, flags, io, cliVersion, bundle, target, plan })) === BACK) {
      if (flags.project) throw new Cancelled('escape');
      continue;
    }
    return 0;
  }
}

// Review loop: if the project no longer matches the reviewed plan once the lock is held, review again.
async function reviewAndInstall({ session, flags, io, cliVersion, bundle, target, plan: first }) {
  let plan = first;
  const warnings = inspect(target.dir, JOURNAL_REL).exists ? [`${JOURNAL_REL} exists: an earlier run was interrupted or another run is active`] : [];
  for (;;) {
    const current = plan;
    const review = createConfirm({
      title: 'Review', confirmLabel: 'Install', detailsToggle: true, guardMs: io.confirmGuardMs,
      body: (state, ctx) => reviewBody({ theme: ctx.theme, project: truncateMiddle(sanitize(shortPath(target.dir, io.home)), ctx.width - 30), plan: current, bundle, hasGit: target.hasGit, warnings }, state),
    });
    if ((await session.run(review)) === BACK) return BACK;
    const outcome = install({ session, flags, io, cliVersion, bundle, project: target.dir, reviewed: current });
    if (!outcome.changed) return 0;
    plan = outcome.plan;
    if (!warnings.includes(CHANGED_NOTE)) warnings.push(CHANGED_NOTE);
  }
}

// Lock, plan again under the lock, apply with a progress bar, release.
// Returns { changed: true, plan } without writing when the fresh plan differs from the reviewed one.
function install({ session, flags, io, cliVersion, bundle, project, reviewed }) {
  const lock = acquireLock(project, 'install', { force: Boolean(flags.force) });
  try {
    const { plan } = buildCommandPlan({ command: 'install', flags, project, bundle, cliVersion });
    if (planSignature(plan) !== planSignature(reviewed)) return { changed: true, plan };
    const shown = truncateMiddle(sanitize(shortPath(project, io.home)), session.ctx().width - 14);
    session.commit([`  ${session.theme.paint('ok', session.theme.sym.ok)} Project  ${session.theme.paint('dim', shown)}`]);
    const show = ({ done, total, path: rel }) => session.draw((ctx) => [
      '', `  Installing ai-sdlc ${sanitize(bundle.version)}`, renderProgress({ theme: ctx.theme, width: ctx.width, done, total, label: sanitize(rel || 'preparing') }),
    ]);
    applyPlan(project, plan, 'install', lock, { onProgress: show });
    rememberProject(project, { env: io.env, home: io.home });
    session.commit(installedPanel({ theme: session.theme, width: session.ctx().width, project: shortPath(project, io.home), plan, version: bundle.version }));
    return { changed: false };
  } finally {
    lock.release();
  }
}

async function runInitFlow({ flags, io, cliVersion }) {
  const theme = createTheme({ env: io.env, stream: io.stdout });
  try {
    return await withSession(sessionOptions(io, theme), (session) => wizard({ session, flags, io, cliVersion }));
  } catch (err) {
    if (err instanceof Cancelled) throw new CliError(err.reason === 'interrupt' ? 'interrupted; nothing was changed' : 'cancelled; nothing was changed');
    throw err;
  }
}

module.exports = { runInitFlow };
