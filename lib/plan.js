'use strict';
const { inspect, utf8Text } = require('./fs-safe');
const { act, planFiles, planRemoveFiles } = require('./plan-files');
const { SETTINGS_REL, renderSettings } = require('./merge-settings');
const { upsertBlock, removeBlock } = require('./merge-claude-md');
const { MANIFEST_REL, buildManifest, serializeManifest } = require('./manifest');

const CLAUDE_MD = 'CLAUDE.md';
// Turns "what the file should contain" into an action (or nothing if unchanged).
function textAction(kind, rel, file, next, detail) {
  const current = utf8Text(file, rel);
  if (next === current) return null;
  if (next === null) return act(kind, 'remove', rel, detail, { remove: true });
  return act(kind, file.exists ? 'update' : 'create', rel, detail, { write: Buffer.from(next, 'utf8') });
}

function settingsStep(project, prior, removeList, addList) {
  const file = inspect(project, SETTINGS_REL);
  const out = renderSettings(utf8Text(file, SETTINGS_REL), prior ? prior.settings : null, removeList, addList);
  const action = textAction('settings', SETTINGS_REL, file, out.text, `${out.added.length} hook(s) tracked`);
  return { action, info: out.info, hooks: out.added };
}

// install and update are the same plan; `prior` (the installed manifest) selects the behaviour.
function planSync({ project, bundle, prior, force, cliVersion, op }) {
  const { actions, tracked } = planFiles({ project, bundle, prior, force, reinstall: op === 'install' });
  const settings = settingsStep(project, prior, prior ? prior.hooks : [], bundle.hooks);
  if (settings.action) actions.push(settings.action);

  let blockInfo = null;
  const md = inspect(project, CLAUDE_MD);
  if (bundle.block) {
    const out = upsertBlock(utf8Text(md, CLAUDE_MD), bundle.block.body, prior ? prior.block : null);
    blockInfo = out.info;
    const a = textAction('block', CLAUDE_MD, md, out.text, 'ai-sdlc router block');
    if (a) actions.push(a);
  } else if (prior && prior.block) {
    const out = removeBlock(utf8Text(md, CLAUDE_MD), prior.block);
    const a = textAction('block', CLAUDE_MD, md, out.text, 'block no longer shipped');
    if (a) actions.push(a);
  }

  const manifest = buildManifest({
    cliVersion,
    payloadVersion: bundle.version,
    payloadSchema: bundle.payloadSchema,
    files: tracked,
    block: blockInfo,
    hooks: settings.hooks,
    settings: settings.info,
  });
  actions.push(act('manifest', prior ? 'update' : 'create', MANIFEST_REL, `payload ${bundle.version}`, { write: serializeManifest(manifest) }));
  return { actions, payloadVersion: bundle.version };
}

function planRemove({ project, prior }) {
  const actions = planRemoveFiles({ project, prior });
  const settings = settingsStep(project, prior, prior.hooks, []);
  if (settings.action) actions.push(settings.action);
  if (prior.block) {
    const md = inspect(project, CLAUDE_MD);
    const a = textAction('block', CLAUDE_MD, md, removeBlock(utf8Text(md, CLAUDE_MD), prior.block).text, 'ai-sdlc router block');
    if (a) actions.push(a);
  }
  actions.push(act('manifest', 'remove', MANIFEST_REL, '', { remove: true }));
  return { actions, payloadVersion: prior.payload_version };
}

// Counts per action name, for the summary line.
function summarize(actions) {
  const out = {};
  for (const a of actions) out[a.action] = (out[a.action] || 0) + 1;
  return out;
}

const publicView = (a) => ({ kind: a.kind, action: a.action, path: a.path, ...(a.detail ? { detail: a.detail } : {}) });

module.exports = { planSync, planRemove, summarize, publicView };
