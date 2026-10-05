'use strict';
// Bare `ai-sdlc` in a terminal: banner, what the current folder looks like,
// and a short list of actions.
const { CliError } = require('../../errors');
const { createTheme } = require('../theme');
const { withSession, Cancelled, BACK } = require('../terminal');
const { createSelectList } = require('../widgets/select-list');
const { bannerLines } = require('./intro');
const { sessionOptions } = require('./session-options');
const { truncateMiddle } = require('../text-width');
const { sanitize } = require('../sanitize');
const { projectState, shortPath } = require('./project-choices');

const ACTIONS = [
  { label: 'Install', hint: 'set up ai-sdlc in a project', value: 'install', hotkey: '1' },
  { label: 'Update', hint: 'bring an installed project up to date', value: 'update', hotkey: '2' },
  { label: 'Doctor', hint: 'check an installed project', value: 'doctor', hotkey: '3' },
  { label: 'Uninstall', hint: 'remove what install added', value: 'uninstall', hotkey: '4' },
  { label: 'Quit', hint: '', value: 'quit', hotkey: '5' },
];

function stateLines(theme, state, cwd, home, width) {
  let status;
  if (state.invalid) status = theme.paint('warn', `${theme.sym.warn} manifest cannot be trusted: ${truncateMiddle(state.invalid, Math.max(20, width - 40))}`);
  else if (state.version) status = theme.paint('ok', `${theme.sym.ok} ai-sdlc ${sanitize(state.version)} installed`);
  else {
    status = theme.paint('dim', 'ai-sdlc not installed');
    if (!state.hasGit) status += `  ${theme.paint('warn', `${theme.sym.warn} no .git`)}`;
  }
  return [`  ${theme.paint('dim', 'Folder')}  ${truncateMiddle(sanitize(shortPath(cwd, home)), width - 12)}`, `  ${theme.paint('dim', 'Status')}  ${status}`];
}

// Resolves to { command, installedHere }. Quit and Esc give command 'quit'.
async function chooseAction({ io }) {
  const theme = createTheme({ env: io.env, stream: io.stdout });
  const state = projectState(io.cwd);
  try {
    const command = await withSession(sessionOptions(io, theme), async (session) => {
      session.commit([...bannerLines(session), ...stateLines(theme, state, io.cwd, io.home, session.ctx().width), '']);
      const picked = await session.run(createSelectList({ title: 'What would you like to do?', items: ACTIONS, filterable: false, maxVisible: ACTIONS.length }));
      session.clear();
      return picked === BACK ? 'quit' : picked.item.value;
    });
    return { command, installedHere: Boolean(state.version) && !state.invalid };
  } catch (err) {
    if (err instanceof Cancelled) throw new CliError(err.reason === 'interrupt' ? 'interrupted; nothing was changed' : 'cancelled; nothing was changed');
    throw err;
  }
}

module.exports = { chooseAction, ACTIONS };
