'use strict';
const { publicView, summarize } = require('./plan');

// Actions that change nothing are folded into a count in human output.
const QUIET = new Set(['unchanged', 'keep-existing', 'forget']);

function planLines(plan) {
  const lines = [];
  const quiet = plan.actions.filter((a) => QUIET.has(a.action)).length;
  for (const a of plan.actions.filter((x) => !QUIET.has(x.action))) {
    lines.push(`  ${a.action.padEnd(13)} ${a.path}${a.detail ? `  (${a.detail})` : ''}`);
  }
  if (quiet) lines.push(`  (${quiet} already in place or user-owned, untouched)`);
  const counts = Object.entries(summarize(plan.actions)).map(([k, v]) => `${v} ${k}`);
  lines.push(`  summary: ${counts.join(', ')}`);
  return lines;
}

function planResult(command, project, plan, extra) {
  return {
    ok: true,
    command,
    project,
    payloadVersion: plan.payloadVersion,
    actions: plan.actions.map(publicView),
    summary: summarize(plan.actions),
    ...extra,
  };
}

function doctorLines(report) {
  const tag = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]', info: '[info]' };
  return report.checks.map((c) => `${tag[c.status]} ${c.name}: ${c.detail}`);
}

module.exports = { planLines, planResult, doctorLines, QUIET };
