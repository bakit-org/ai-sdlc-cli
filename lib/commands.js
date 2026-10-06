'use strict';
const os = require('os');
const pkg = require('../package.json');
const { CliError, UsageError } = require('./errors');
const { parseArgs, validateFlags, HELP } = require('./cli-args');
const { loadReleaseBundle } = require('./release-source');
const { createGithubClient, createReleaseFetcher } = require('./github-release');
const { JOURNAL_REL } = require('./path-rules');
const { acquireLock } = require('./journal');
const { inspect } = require('./fs-safe');
const { buildCommandPlan } = require('./command-plan');
const { applyPlan } = require('./apply-plan');
const { createPrompter, confirm, pickProject } = require('./project-picker');
const { runDoctor } = require('./doctor');
const { readManifest } = require('./manifest');
const { planLines, planResult, doctorLines } = require('./cli-output');
const { shouldUseTui, shouldRunWizard } = require('./tui/launch');

const MUTATING = new Set(['install', 'update', 'uninstall']);

function makeIo(env) {
  const github = env.github || createGithubClient({
    env: env.env || process.env, runCommand: env.runCommand, fetchImpl: env.fetch, releaseOptions: env.releaseOptions, proc: env.proc,
  });
  const stdin = env.stdin || process.stdin;
  const stdout = env.stdout || process.stdout;
  return {
    stdin,
    stdout,
    stderr: env.stderr || process.stderr,
    cwd: env.cwd || process.cwd(),
    home: env.home || os.homedir(),
    isTTY: env.isTTY !== undefined ? env.isTTY : Boolean(stdin.isTTY && stdout.isTTY),
    probePython: env.probePython,
    github,
    fetchLatestBundle: env.fetchLatestBundle || createReleaseFetcher({ client: github }),
    env: env.env || process.env,
    proc: env.proc || process,
    tui: env.tui,
    execFile: env.execFile,
    extraChecks: env.extraChecks,
    escapeMs: env.escapeMs,
    confirmGuardMs: env.confirmGuardMs,
  };
}

// Without a terminal nothing may be asked, so the answers must be on the command line.
function requireNonInteractiveInputs(command, flags, io) {
  const interactive = io.isTTY && !flags.json;
  if (interactive) return true;
  if (!flags.project) throw new UsageError('--project <path> is required when not running in an interactive terminal');
  if (MUTATING.has(command) && !flags.dryRun && !flags.yes) {
    throw new UsageError('--yes is required to apply changes when not running in an interactive terminal (or use --dry-run)');
  }
  return false;
}

// Without --project (or --root), update/doctor/uninstall act on the current folder when ai-sdlc is installed there.
function installedHere(command, flags, io) {
  if (command === 'install' || flags.root) return undefined;
  try {
    return readManifest(io.cwd) ? io.cwd : undefined;
  } catch (_) {
    return io.cwd; // a manifest file is there but unreadable: let the command report why
  }
}

async function runProjectCommand(command, flags, io, say) {
  const interactive = requireNonInteractiveInputs(command, flags, io);
  const log = (line = '') => (flags.json ? undefined : say.stdout.write(`${line}\n`));
  // On a terminal, update/doctor/uninstall print coloured result views instead of plain lines.
  const view = command !== 'install' && shouldUseTui(flags, io) ? require('./tui/flows/terminal-views').createViews(io) : null;
  const emit = (lines) => say.stdout.write(`${lines.join('\n')}\n`);
  const prompter = interactive ? createPrompter({ input: io.stdin, output: io.stdout }) : null;
  let lock = null;
  try {
    let bundle = null;
    if (command === 'install' || command === 'update' || (command === 'doctor' && flags.fromBundle)) {
      bundle = await loadReleaseBundle({ fromBundle: flags.fromBundle, version: flags.version, cwd: io.cwd }, { fetchLatestBundle: io.fetchLatestBundle }, { cliVersion: pkg.version });
    }
    const bundleWarnings = bundle ? [...bundle.warnings] : [];
    const target = await pickProject({
      project: flags.project || installedHere(command, flags, io), root: flags.root, cwd: io.cwd, home: io.home, prompter,
      output: flags.json ? { write() {} } : say.stdout,
    });
    const project = target.dir;
    const warnings = target.hasGit ? bundleWarnings : [...bundleWarnings, `${project} has no .git directory`];
    if (!flags.json) for (const w of bundleWarnings) say.stderr.write(`warning: ${w}\n`);

    if (command === 'doctor') {
      const report = runDoctor({ project, nodeVersion: process.version, bundleVersion: bundle && bundle.version, probePython: io.probePython });
      if (flags.json) say.stdout.write(`${JSON.stringify({ ...report, command, project, warnings }, null, 2)}\n`);
      else if (view) emit(view.doctor({ project, report, warnings: warnings.filter((w) => !bundleWarnings.includes(w)) }));
      else {
        log(`ai-sdlc doctor: ${project}`);
        doctorLines(report).forEach((l) => log(l));
      }
      return report.ok ? 0 : 1;
    }

    // Real runs hold the project lock (and the recovery journal) from here on.
    if (!flags.dryRun) lock = acquireLock(project, command, { force: Boolean(flags.force) });
    else if (inspect(project, JOURNAL_REL).exists) warnings.push(`${JOURNAL_REL} exists: an earlier run was interrupted or another run is active`);

    const { plan } = buildCommandPlan({ command, flags, project, bundle, cliVersion: pkg.version });

    if (view && !flags.json) emit(view.plan({ command, project, plan, dryRun: Boolean(flags.dryRun) }));
    else {
      log(`ai-sdlc ${command}${flags.dryRun ? ' (dry run, nothing will be written)' : ''}`);
      log(`  project: ${project}`);
      log(`  payload: ${plan.payloadVersion}`);
      planLines(plan).forEach((l) => log(l));
    }

    const result = planResult(command, project, plan, { dryRun: Boolean(flags.dryRun), warnings });
    if (flags.dryRun) return emitJson(flags, say, result, 0);

    if (!flags.yes) {
      if (!(await confirm(prompter, 'Apply these changes?'))) throw new CliError('not confirmed; nothing was changed');
    }
    applyPlan(project, plan, command, lock);
    if (view && !flags.json) emit(view.done({ command, plan }));
    else {
      log('done.');
      if (plan.actions.some((a) => a.action === 'write-new')) log('Review the *.new files next to the files you modified and merge by hand.');
    }
    return emitJson(flags, say, result, 0);
  } finally {
    if (lock) lock.release();
    if (prompter) prompter.close();
  }
}

function emitJson(flags, say, result, code) {
  if (flags.json) say.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return code;
}

// Messages can embed repo-controlled paths: on a terminal show control characters as text (line breaks kept).
const forTerminal = (text, stream) => (stream && stream.isTTY ? String(text).split('\n').map((l) => require('./tui/sanitize').sanitize(l)).join('\n') : text);
const runWizard = (flags, io, command = 'install') => require('./tui/flows/init-flow').runInitFlow({ flags, io, cliVersion: pkg.version, command });

// Bare `ai-sdlc` in a terminal: pick an action, then run it like the typed command.
async function runMenu(flags, io, say) {
  const { command, installedHere } = await require('./tui/flows/menu-flow').chooseAction({ io });
  if (command === 'quit') return 0;
  if ((command === 'install' || command === 'update') && shouldRunWizard(flags, io)) return runWizard(flags, io, command);
  const target = installedHere && !flags.project && command !== 'install' ? { ...flags, project: io.cwd } : flags;
  return runProjectCommand(command, target, io, say);
}

async function run(argv, env = {}) {
  const io = makeIo(env);
  const say = { stdout: io.stdout, stderr: io.stderr };
  let flags = { json: argv.includes('--json') };
  try {
    const parsed = parseArgs(argv);
    flags = parsed.flags;
    validateFlags(parsed.command, flags);
    switch (parsed.command) {
      case 'version':
        if (flags.check) return await require('./version-check').runVersionCheck(flags, io, say);
        say.stdout.write(flags.json ? `${JSON.stringify({ version: pkg.version })}\n` : `ai-sdlc-cli ${pkg.version}\n`);
        return 0;
      case 'help':
        say.stdout.write(HELP);
        return 0;
      case null:
        if (shouldUseTui(flags, io)) return await runMenu(flags, io, say);
        say.stderr.write(HELP);
        return 2;
      default:
        if ((flags.init || parsed.command === 'update') && shouldRunWizard(flags, io)) return await runWizard(flags, io, parsed.command === 'update' ? 'update' : 'install');
        return await runProjectCommand(parsed.command, flags, io, say);
    }
  } catch (err) {
    const code = err instanceof CliError ? err.exitCode : 1;
    if (flags.json) say.stdout.write(`${JSON.stringify({ ok: false, error: err.message, exitCode: code })}\n`);
    else say.stderr.write(`ai-sdlc: ${forTerminal(err instanceof CliError || err.code ? err.message : err.stack, say.stderr)}\n`);
    return code;
  }
}

module.exports = { run };
