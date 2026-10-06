'use strict';
// Body of the review screen: what the run will do, grouped by file class.
const { padEnd } = require('../text-width');
const { sanitize } = require('../sanitize');
const { planRows } = require('./result-views');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Per-class tallies: { managed: { total, by: { create: 2 } }, 'user-once': {...} }.
function tallyByClass(plan, bundle) {
  const classOf = new Map(((bundle && bundle.files) || []).map((f) => [f.path, f.class]));
  const out = { managed: { total: 0, by: {} }, 'user-once': { total: 0, by: {} } };
  for (const a of plan.actions.filter((x) => x.kind === 'file')) {
    const cls = classOf.get(a.action === 'write-new' ? a.path.replace(/\.new$/, '') : a.path) || 'managed';
    if (a.action !== 'write-new') out[cls].total += 1;
    out[cls].by[a.action] = (out[cls].by[a.action] || 0) + 1;
  }
  return out;
}

const breakdown = (by) => Object.entries(by).map(([k, v]) => `${sanitize(k)} ${v}`).join(', ');

// ctx: { theme, project, plan, bundle, hasGit, warnings, fromVersion }
function reviewBody({ theme, project, plan, bundle, hasGit, warnings = [], fromVersion = '' }, state) {
  const dim = (s) => theme.paint('dim', s);
  const tally = tallyByClass(plan, bundle);
  const block = plan.actions.find((a) => a.kind === 'block');
  const settings = plan.actions.find((a) => a.kind === 'settings');
  const hookCount = bundle ? bundle.hooks.length : 0;
  const row = (name, text, extra) => `  ${theme.paint('accent', padEnd(name, 10))} ${padEnd(text, 18)} ${dim(extra)}`;

  const version = fromVersion ? `${sanitize(fromVersion)} ${theme.sym.arrow} ${sanitize(plan.payloadVersion)}` : sanitize(plan.payloadVersion);
  const lines = [`${theme.paint('bold', `ai-sdlc ${version}`)} ${theme.sym.arrow} ${sanitize(project)}`, ''];
  lines.push(row('managed', plural(tally.managed.total, 'file'), breakdown(tally.managed.by)));
  lines.push(row('user-once', plural(tally['user-once'].total, 'starter file'), breakdown(tally['user-once'].by)));
  lines.push(row('block', 'CLAUDE.md block', block ? sanitize(block.action) : 'unchanged'));
  lines.push(row('hooks', plural(hookCount, 'hook'), `.claude/settings.json ${settings ? sanitize(settings.action) : 'unchanged'}`));
  lines.push('', dim('  CLAUDE.md: only the marked ai-sdlc block is managed; the rest of the file is never touched.'));
  lines.push(dim('  Starter files are created only if missing and never overwritten.'));
  if (!hasGit) lines.push('', `  ${theme.paint('warn', `${theme.sym.warn} no .git directory here; this may not be a repository root`)}`);
  for (const w of warnings) lines.push(`  ${theme.paint('warn', `${theme.sym.warn} ${sanitize(w)}`)}`);
  if (state.expanded) lines.push('', theme.paint('bold', '  Full list'), ...planRows(theme, plan));
  return lines;
}

module.exports = { reviewBody, tallyByClass };
