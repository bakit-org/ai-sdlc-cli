'use strict';
// Static views (frames are plain string[]) for results: doctor checklist,
// plan listing, and the closing panels. No input handling here.
const { summarize } = require('../../plan');
const { QUIET } = require('../../cli-output');
const { padEnd, truncateMiddle } = require('../text-width');
const { sanitize } = require('../sanitize');
const { renderPanel } = require('../widgets/panel');

const ACTION_TONE = {
  create: 'ok', restore: 'ok', replace: 'accent', update: 'accent', 'write-new': 'warn', 'skip-deleted': 'warn',
  'keep-modified': 'warn', delete: 'err', remove: 'err', 'keep-existing': 'dim', unchanged: 'dim', forget: 'dim',
};
const STATUS_SYMBOL = { ok: 'ok', warn: 'warn', fail: 'err', info: 'info' };

const counts = (actions) => Object.entries(summarize(actions)).map(([k, v]) => `${v} ${sanitize(k)}`).join(', ');

function checkRow(theme, check, nameWidth) {
  const tone = theme.tone(check.status);
  const mark = theme.sym[STATUS_SYMBOL[check.status] || 'info'];
  return `  ${theme.paint(tone, mark)} ${padEnd(sanitize(check.name), nameWidth)}  ${theme.paint('dim', sanitize(check.detail))}`;
}

function doctorView({ theme, width, project, report, warnings = [] }) {
  const nameWidth = Math.max(0, ...report.checks.map((c) => sanitize(c.name).length));
  const by = (s) => report.checks.filter((c) => c.status === s).length;
  const failed = by('fail');
  const warned = by('warn');
  const tone = failed ? 'err' : warned ? 'warn' : 'ok';
  const verdict = failed ? 'Problems found' : warned ? 'Healthy, with warnings' : 'Healthy';
  return [
    '',
    `  ${theme.paint('bold', 'ai-sdlc doctor')}  ${theme.paint('dim', truncateMiddle(sanitize(project), width - 20))}`,
    '',
    ...report.checks.map((c) => checkRow(theme, c, nameWidth)),
    ...warnings.map((w) => `  ${theme.paint('warn', theme.sym.warn)} ${sanitize(w)}`),
    '',
    ...renderPanel({
      theme, width, tone, title: verdict,
      lines: [`${report.checks.length} checks: ${by('ok')} ok, ${warned} warning(s), ${failed} failed`],
    }),
  ];
}

// Action rows, quiet ones folded into one line. `limit` caps the rows (null = all).
function planRows(theme, plan, limit = null) {
  const loud = plan.actions.filter((a) => !QUIET.has(a.action));
  const shown = limit === null ? loud : loud.slice(0, limit);
  const rows = shown.map((a) => {
    const tone = ACTION_TONE[a.action] || 'dim';
    return `  ${theme.paint(tone, theme.sym.bullet)} ${theme.paint(tone, padEnd(sanitize(a.action), 13))} ${sanitize(a.path)}${a.detail ? theme.paint('dim', `  (${sanitize(a.detail)})`) : ''}`;
  });
  if (shown.length < loud.length) rows.push(theme.paint('dim', `  ${theme.sym.ellipsis} ${loud.length - shown.length} more`));
  const quiet = plan.actions.length - loud.length;
  if (quiet) rows.push(theme.paint('dim', `  (${quiet} already in place or user-owned, untouched)`));
  return rows;
}

function planView({ theme, width, command, project, plan, dryRun }) {
  return [
    '',
    `  ${theme.paint('bold', `ai-sdlc ${command}`)}${dryRun ? theme.paint('warn', '  dry run, nothing will be written') : ''}`,
    `  ${theme.paint('dim', `project: ${truncateMiddle(sanitize(project), width - 14)}`)}`,
    `  ${theme.paint('dim', `payload: ${sanitize(plan.payloadVersion)}`)}`,
    '',
    ...planRows(theme, plan),
    '',
    `  ${theme.paint('dim', `summary: ${counts(plan.actions)}`)}`,
  ];
}

function doneView({ theme, width, command, plan }) {
  const lines = [`${command} finished: ${counts(plan.actions)}`];
  if (plan.actions.some((a) => a.action === 'write-new')) lines.push('Review the *.new files next to the files you modified and merge by hand.');
  return ['', ...renderPanel({ theme, width, tone: 'ok', title: `${theme.sym.ok} Done`, lines })];
}

// The wizard's closing panel: what was written and what to do next.
function installedPanel({ theme, width, project, plan, version }) {
  const written = plan.actions.filter((a) => a.write).length;
  const lines = [`ai-sdlc ${sanitize(version)} installed into ${truncateMiddle(sanitize(project), width - 30)}`, `${written} file(s) written (${counts(plan.actions)})`, '', 'Next steps:', '  1. Open this folder in Claude Code (terminal or the VS Code extension).'];
  let n = 2;
  if (plan.actions.some((a) => a.path === 'ai-sdlc/project.md')) lines.push(`  ${n++}. Fill in ai-sdlc/project.md with what your project is about.`);
  lines.push(`  ${n++}. Run \`ai-sdlc doctor\` in the project to check the install.`);
  if (plan.actions.some((a) => a.action === 'write-new')) lines.push('', 'Review the *.new files next to files you modified and merge by hand.');
  return ['', ...renderPanel({ theme, width, tone: 'ok', title: `${theme.sym.ok} Installed`, lines })];
}

// Closing panel of the guided update.
function updatedPanel({ theme, width, project, plan, version, fromVersion }) {
  const written = plan.actions.filter((a) => a.write).length;
  const lines = [`ai-sdlc ${fromVersion ? `${sanitize(fromVersion)} -> ` : ''}${sanitize(version)} in ${truncateMiddle(sanitize(project), width - 30)}`, `${written} file(s) written (${counts(plan.actions)})`, '', 'Run `ai-sdlc doctor` in the project to check it.'];
  if (plan.actions.some((a) => a.action === 'write-new')) lines.push('', 'Review the *.new files next to files you modified and merge by hand.');
  return ['', ...renderPanel({ theme, width, tone: 'ok', title: `${theme.sym.ok} Updated`, lines })];
}

function upToDatePanel({ theme, width, project, version, warnings = [] }) {
  const lines = [`ai-sdlc ${sanitize(version)} is already installed in ${truncateMiddle(sanitize(project), width - 40)}`, ...warnings.map((w) => `${theme.sym.warn} ${sanitize(w)}`)];
  return ['', ...renderPanel({ theme, width, tone: warnings.length ? 'warn' : 'ok', title: `${theme.sym.ok} Up to date`, lines })];
}

module.exports = { updatedPanel, upToDatePanel, doctorView, planView, planRows, doneView, installedPanel, counts };
