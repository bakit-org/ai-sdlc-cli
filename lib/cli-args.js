'use strict';
const { UsageError } = require('./errors');

const COMMANDS = ['init', 'install', 'update', 'doctor', 'uninstall', 'version', 'help'];
const VALUE_FLAGS = { '--project': 'project', '--root': 'root', '--from-bundle': 'fromBundle' };
const BOOL_FLAGS = { '--dry-run': 'dryRun', '--force': 'force', '--yes': 'yes', '-y': 'yes', '--json': 'json', '--no-tui': 'noTui', '--help': 'help', '-h': 'help' };

// Returns { command, flags }. Anything unrecognised is a usage error (exit 2).
function parseArgs(argv) {
  const flags = {};
  let command = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (VALUE_FLAGS[name]) {
      const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new UsageError(`${name} needs a value`);
      flags[VALUE_FLAGS[name]] = value;
    } else if (BOOL_FLAGS[name] && eq === -1) {
      flags[BOOL_FLAGS[name]] = true;
    } else if (arg === '--version' || arg === '-v') {
      command = command || 'version';
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else if (command === null) {
      if (!COMMANDS.includes(arg)) throw new UsageError(`unknown command "${arg}"`);
      // init is install with a guided wizard when a terminal is available.
      command = arg === 'init' ? 'install' : arg;
      if (arg === 'init') flags.init = true;
    } else {
      throw new UsageError(`unexpected argument "${arg}"`);
    }
  }
  if (flags.help) command = 'help';
  return { command, flags };
}

const HELP = `ai-sdlc - install the ai-sdlc Claude Code harness into a project

Usage: ai-sdlc <command> [options]

Commands:
  init         guided install in a terminal; otherwise the same as install
  install      install into a project (refuses if already installed; see --force)
  update       bring an installed project up to the given bundle
  doctor       read-only health check of an installed project
  uninstall    remove what install added, keep anything you changed
  version      print the CLI version

Options:
  --project <path>      target project directory (skips the picker)
  --root <dir>          where the picker looks for git repositories
  --from-bundle <file>  use a local release bundle (<file>.sha256 is verified when present)
  --dry-run             show exactly what would change, write nothing
  --force               reinstall over an existing install / overwrite modified managed files
  --yes, -y             do not ask for confirmation
  --json                machine-readable output (needs --project; mutating runs also need --yes)
  --no-tui              plain text output and prompts, no interactive screens

Run without a command in a terminal to open a menu.

Exit codes: 0 ok, 1 failure, 2 usage error.
`;

module.exports = { parseArgs, HELP };
