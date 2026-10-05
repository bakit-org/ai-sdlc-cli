'use strict';
const os = require('os');
const pkg = require('../package.json');
const { CliError, UsageError } = require('./errors');
const { parseArgs, HELP } = require('./cli-args');
const { resolveBundle } = require('./release-source');
const { loadBundle } = require('./bundle');
const { readManifest } = require('./manifest');
const { JOURNAL_REL } = require('./path-rules');
const { acquireLock } = require('./journal');
const { inspect } = require('./fs-safe');
const { planSync, planRemove } = require('./plan');
const { applyPlan } = require('./apply-plan');
const { createPrompter, confirm, pickProject } = require('./project-picker');
const { runDoctor } = require('./doctor');
const { planLines, planResult, doctorLines } = require('./cli-output');

const MUTATING = new Set(['install', 'update', 'uninstall']);

function makeIo(env) {
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
    fetchLatestBundle: env.fetchLatestBundle,
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

async function runProjectCommand(command, flags, io, say) {
  const interactive = requireNonInteractiveInputs(command, flags, io);
  const log = (line = '') => (flags.json ? undefined : say.stdout.write(`${line}\n`));
  const prompter = interactive ? createPrompter({ input: io.stdin, output: io.stdout }) : null;
  let lock = null;
  try {
    let bundle = null;
    if (command === 'install' || command === 'update' || (command === 'doctor' && flags.fromBundle)) {
      const source = await resolveBundle({ fromBundle: flags.fromBundle, cwd: io.cwd }, { fetchLatestBundle: io.fetchLatestBundle });
      bundle = loadBundle(source, { cliVersion: pkg.version });
    }
    const bundleWarnings = bundle ? [...bundle.warnings] : [];
    const target = await pickProject({
      project: flags.project, root: flags.root, cwd: io.cwd, home: io.home, prompter,
      output: flags.json ? { write() {} } : say.stdout,
    });
    const project = target.dir;
    const warnings = target.hasGit ? bundleWarnings : [...bundleWarnings, `${project} has no .git directory`];
    if (!flags.json) for (const w of bundleWarnings) say.stderr.write(`warning: ${w}\n`);

    if (command === 'doctor') {
      const report = runDoctor({ project, nodeVersion: process.version, bundleVersion: bundle && bundle.version, probePython: io.probePython });
      if (flags.json) say.stdout.write(`${JSON.stringify({ ...report, command, project, warnings }, null, 2)}\n`);
      else {
        log(`ai-sdlc doctor: ${project}`);
        doctorLines(report).forEach((l) => log(l));
      }
      return report.ok ? 0 : 1;
    }

    // Real runs hold the project lock (and the recovery journal) from here on.
    if (!flags.dryRun) lock = acquireLock(project, command, { force: Boolean(flags.force) });
    else if (inspect(project, JOURNAL_REL).exists) warnings.push(`${JOURNAL_REL} exists: an earlier run was interrupted or another run is active`);

    const prior = readManifest(project);
    if (command === 'install' && prior && !flags.force) {
      throw new CliError(`already installed (payload ${prior.payload_version}); use "ai-sdlc update", or --force to reinstall`);
    }
    if (command !== 'install' && !prior) throw new CliError(`ai-sdlc is not installed in ${project}`);

    const plan = command === 'uninstall'
      ? planRemove({ project, prior })
      : planSync({ project, bundle, prior, force: flags.force, cliVersion: pkg.version, op: command });

    log(`ai-sdlc ${command}${flags.dryRun ? ' (dry run, nothing will be written)' : ''}`);
    log(`  project: ${project}`);
    log(`  payload: ${plan.payloadVersion}`);
    planLines(plan).forEach((l) => log(l));

    const result = planResult(command, project, plan, { dryRun: Boolean(flags.dryRun), warnings });
    if (flags.dryRun) return emitJson(flags, say, result, 0);

    if (!flags.yes) {
      if (!(await confirm(prompter, 'Apply these changes?'))) throw new CliError('not confirmed; nothing was changed');
    }
    applyPlan(project, plan, command, lock);
    log('done.');
    if (plan.actions.some((a) => a.action === 'write-new')) log('Review the *.new files next to the files you modified and merge by hand.');
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

async function run(argv, env = {}) {
  const io = makeIo(env);
  const say = { stdout: io.stdout, stderr: io.stderr };
  let flags = { json: argv.includes('--json') };
  try {
    const parsed = parseArgs(argv);
    flags = parsed.flags;
    switch (parsed.command) {
      case 'version':
        say.stdout.write(flags.json ? `${JSON.stringify({ version: pkg.version })}\n` : `ai-sdlc-cli ${pkg.version}\n`);
        return 0;
      case 'help':
        say.stdout.write(HELP);
        return 0;
      case null:
        say.stderr.write(HELP);
        return 2;
      default:
        return await runProjectCommand(parsed.command, flags, io, say);
    }
  } catch (err) {
    const code = err instanceof CliError ? err.exitCode : 1;
    if (flags.json) say.stdout.write(`${JSON.stringify({ ok: false, error: err.message, exitCode: code })}\n`);
    else say.stderr.write(`ai-sdlc: ${err instanceof CliError || err.code ? err.message : err.stack}\n`);
    return code;
  }
}

module.exports = { run };
