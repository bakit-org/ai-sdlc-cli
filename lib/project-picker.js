'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { UsageError, CliError } = require('./errors');

// Line-oriented prompter over any readable stream (a TTY or scripted input).
function createPrompter({ input, output }) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  return {
    // Resolves to the trimmed answer, or null once input has ended.
    async ask(question) {
      output.write(question);
      const next = await lines.next();
      return next.done ? null : String(next.value).trim();
    },
    close() {
      rl.close();
    },
  };
}

async function confirm(prompter, question) {
  const answer = await prompter.ask(`${question} [y/N] `);
  return answer !== null && /^y(es)?$/i.test(answer);
}

const hasGit = (dir) => fs.existsSync(path.join(dir, '.git'));

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

// Accepts a path only if it is an existing directory that is not the home
// directory or a filesystem root. Returns { dir (real path), hasGit }.
function validateTarget(input, { cwd, home }) {
  if (typeof input !== 'string' || !input.trim()) throw new UsageError('project path is empty');
  const abs = path.resolve(cwd, expandHome(input.trim(), home));
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (_) {
    throw new UsageError(`project path does not exist: ${abs}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new UsageError(`project path is not a directory: ${abs}`);
  if (path.parse(real).root === real) throw new UsageError('refusing to use a filesystem root as the project');
  let realHome = null;
  try {
    realHome = fs.realpathSync(home);
  } catch (_) {
    /* no usable home: nothing to compare with */
  }
  if (realHome && realHome === real) throw new UsageError('refusing to install into the home directory; pick a project repository');
  return { dir: real, hasGit: hasGit(real) };
}

// Repositories (directories with .git) directly under each base, plus the base itself.
// `limit` stops the scan once that many have been found.
function findRepos(bases, limit = Infinity) {
  const found = new Map();
  const add = (dir) => {
    if (found.size < limit && hasGit(dir) && !found.has(dir)) found.set(dir, true);
  };
  for (const base of bases) {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    add(base);
    for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.') && x.name !== 'node_modules')) {
      if (found.size >= limit) break;
      add(path.join(base, e.name));
    }
  }
  return [...found.keys()];
}

async function chooseInteractively({ root, cwd, home, prompter, output }) {
  const bases = root ? [path.resolve(cwd, root)] : [cwd, path.dirname(cwd)];
  const repos = findRepos(bases);
  output.write('Select the project to install into:\n');
  repos.forEach((dir, i) => output.write(`  ${i + 1}) ${dir}\n`));
  output.write(`  p) enter a path\n  q) cancel\n`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await prompter.ask('> ');
    if (answer === null || /^q/i.test(answer)) throw new CliError('cancelled; nothing was changed');
    let candidate = null;
    if (/^\d+$/.test(answer) && repos[Number(answer) - 1]) candidate = repos[Number(answer) - 1];
    else if (/^p$/i.test(answer)) {
      const typed = await prompter.ask('Project path: ');
      if (typed === null) throw new CliError('cancelled; nothing was changed');
      candidate = typed;
    } else output.write('Not a valid choice.\n');
    if (candidate === null) continue;
    try {
      return validateTarget(candidate, { cwd, home });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      output.write(`${err.message}\n`);
    }
  }
  throw new UsageError('no valid project selected');
}

// --project wins; otherwise an interactive choice. Warns when the target is not a git repository.
async function pickProject({ project, root, cwd, home, prompter, output }) {
  const target = project ? validateTarget(project, { cwd, home }) : await chooseInteractively({ root, cwd, home, prompter, output });
  if (!target.hasGit) output.write(`warning: ${target.dir} has no .git directory; it may not be a repository root\n`);
  return target;
}

module.exports = { createPrompter, confirm, pickProject, validateTarget, findRepos, expandHome };
