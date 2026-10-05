'use strict';
const { CliError } = require('./errors');

const BEGIN = '<!-- ai-sdlc:begin -->';
const END = '<!-- ai-sdlc:end -->';

function findSpan(text) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b === -1 && e === -1) return null;
  if (b === -1 || e === -1 || e < b) {
    throw new CliError('CLAUDE.md has an unbalanced ai-sdlc marker pair; fix it by hand and re-run. Nothing was changed.');
  }
  return { start: b, end: e + END.length };
}

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

function renderBlock(body, eol) {
  const lines = body.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return [BEGIN, ...lines, END].join(eol);
}

// Inserts or refreshes the managed block. `info` is what an earlier call
// returned; it records exactly the separator added so removal can restore the
// original bytes. Returns { text, info }.
function upsertBlock(current, body, info) {
  if (current === null) {
    return { text: `${renderBlock(body, '\n')}\n`, info: { created: true, prefix: '', eol: '\n' } };
  }
  const span = findSpan(current);
  if (span) {
    const eol = info ? info.eol : detectEol(current);
    const text = current.slice(0, span.start) + renderBlock(body, eol) + current.slice(span.end);
    return { text, info: info || { created: false, prefix: '', eol } };
  }
  const eol = detectEol(current);
  let prefix = '';
  if (current !== '') prefix = current.endsWith('\n') ? eol : eol + eol;
  return {
    text: `${current}${prefix}${renderBlock(body, eol)}${eol}`,
    info: { created: false, prefix, eol },
  };
}

// Strips the managed block. text === null means "the CLI created this file and
// nothing else is in it, so delete it".
function removeBlock(current, info) {
  if (current === null) return { text: null, changed: false };
  const span = findSpan(current);
  if (!span) return { text: current, changed: false };
  let { start, end } = span;
  if (current.startsWith(info.eol, end)) end += info.eol.length;
  if (info.prefix && current.slice(start - info.prefix.length, start) === info.prefix) start -= info.prefix.length;
  const text = current.slice(0, start) + current.slice(end);
  return { text: text === '' && info.created ? null : text, changed: true };
}

function hasBlock(current) {
  return current !== null && findSpan(current) !== null;
}

module.exports = { BEGIN, END, upsertBlock, removeBlock, hasBlock };
