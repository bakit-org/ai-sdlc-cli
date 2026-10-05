'use strict';
const { isDeepStrictEqual } = require('util');
const { CliError } = require('./errors');

const SETTINGS_REL = '.claude/settings.json';

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Strict parse: anything unexpected aborts before a single byte is written.
function parseSettings(text) {
  if (text === null) return {};
  let value;
  try {
    value = JSON.parse(stripBom(text));
  } catch (err) {
    throw new CliError(`${SETTINGS_REL} is not valid JSON (${err.message}); fix it and re-run. Nothing was changed.`);
  }
  const wrong = (why) => {
    throw new CliError(`${SETTINGS_REL}: ${why}; fix it and re-run. Nothing was changed.`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) wrong('top level must be an object');
  if (value.hooks !== undefined) {
    if (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks)) wrong('"hooks" must be an object');
    for (const [event, list] of Object.entries(value.hooks)) {
      if (!Array.isArray(list)) wrong(`hooks.${event} must be an array`);
    }
  }
  return value;
}

function detectFormat(text) {
  if (text === null) return { eol: '\n', indent: '  ', trailing: true, bom: false };
  const body = stripBom(text);
  const indentMatch = /\n([ \t]+)\S/.exec(body);
  let indent = '  ';
  if (indentMatch) indent = indentMatch[1];
  else if (!body.trim().includes('\n')) indent = '';
  return { eol: body.includes('\r\n') ? '\r\n' : '\n', indent, trailing: /\n$/.test(body), bom: body !== text };
}

function serialize(obj, fmt) {
  let out = JSON.stringify(obj, null, fmt.indent);
  if (fmt.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  if (fmt.trailing) out += fmt.eol;
  return (fmt.bom ? '﻿' : '') + out;
}

const entryMatcher = (h) => (h.matcher === undefined ? '' : h.matcher);
const sameCommand = (x, h) => x && x.type === 'command' && x.command === h.command;

function matchingEntries(obj, h) {
  const list = (obj.hooks && obj.hooks[h.event]) || [];
  return list.filter((e) => e && Array.isArray(e.hooks) && (e.matcher === undefined ? '' : e.matcher) === entryMatcher(h));
}

const hasHook = (obj, h) => matchingEntries(obj, h).some((e) => e.hooks.some((x) => sameCommand(x, h)));

function addHook(obj, h) {
  if (hasHook(obj, h)) return false;
  obj.hooks = obj.hooks || {};
  obj.hooks[h.event] = obj.hooks[h.event] || [];
  const entry = h.matcher === undefined ? {} : { matcher: h.matcher };
  entry.hooks = [{ type: 'command', command: h.command }];
  obj.hooks[h.event].push(entry);
  return true;
}

// Removes the first occurrence of exactly this hook; other entries stay.
function removeHook(obj, h) {
  for (const entry of matchingEntries(obj, h)) {
    const i = entry.hooks.findIndex((x) => sameCommand(x, h));
    if (i === -1) continue;
    entry.hooks.splice(i, 1);
    if (!entry.hooks.length) obj.hooks[h.event].splice(obj.hooks[h.event].indexOf(entry), 1);
    return true;
  }
  return false;
}

// Drops event arrays (and then "hooks") that an edit left empty.
function pruneEmpty(obj, events) {
  if (!obj.hooks) return;
  for (const ev of events) if (Array.isArray(obj.hooks[ev]) && !obj.hooks[ev].length) delete obj.hooks[ev];
  if (!Object.keys(obj.hooks).length) delete obj.hooks;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// currentText: file text or null when absent. info: manifest.settings or null.
// Returns { text, info, added }; text === null means "delete the file".
function renderSettings(currentText, info, removeList, addList) {
  if (!removeList.length && !addList.length) return { text: currentText, info, added: [] };
  const fmt = detectFormat(currentText);
  const obj = parseSettings(currentText);
  // A hook that is both installed and shipped again stays where it is.
  const sameHook = (a, b) => a.event === b.event && entryMatcher(a) === entryMatcher(b) && a.command === b.command;
  const kept = removeList.filter((r) => addList.some((a) => sameHook(a, r)) && hasHook(obj, r));
  const dropped = removeList.filter((r) => !kept.includes(r));
  for (const h of dropped) removeHook(obj, h);
  const added = addList.filter((h) => kept.some((k) => sameHook(k, h)) || addHook(obj, h));
  const touched = [...new Set(dropped.map((h) => h.event))];
  pruneEmpty(obj, touched);

  if (isDeepStrictEqual(obj, parseSettings(currentText))) {
    return { text: currentText, info: added.length ? info : null, added };
  }
  if (added.length) {
    const nextInfo = info || { created: currentText === null, original: currentText === null ? null : b64(currentText) };
    return { text: serialize(obj, fmt), info: nextInfo, added };
  }
  // No hooks of ours remain: give the file back the way it was before the install.
  if (info && info.original !== null) {
    const original = unb64(info.original);
    const origObj = parseSettings(original);
    pruneEmpty(origObj, touched);
    if (isDeepStrictEqual(obj, origObj)) return { text: original, info: null, added };
  }
  if (info && info.created && !Object.keys(obj).length) return { text: null, info: null, added };
  return { text: serialize(obj, fmt), info: null, added };
}

module.exports = { SETTINGS_REL, parseSettings, hasHook, renderSettings };
