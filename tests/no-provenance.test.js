'use strict';
// Shipped code, docs and tests must not name the products this tool descends
// from. The patterns are assembled from fragments so this file does not trip itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const join = (...parts) => parts.join('');
const BANNED = new RegExp(
  [join('ba', '-kit'), join('bak', 'it'), join('agent', 'kit'), join('agent', ' kit'), join('\\b', 'ak', ':'), join('nash', 'tech')].join('|'),
  'i',
);
// The one permitted coordinate form: the GitHub org/repo of the two projects.
const ALLOWED = new RegExp(`${join('bak', 'it')}-org/ai-sdlc-(?:kit|cli)`, 'gi');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '.git'].includes(e.name) ? [] : walk(p);
    return [p];
  });
}

test('no provenance strings in lib, bin, tests, README, docs or package.json', () => {
  const targets = [
    ...['lib', 'bin', 'tests', 'docs'].filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap((d) => walk(path.join(ROOT, d))),
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'package.json'),
  ].filter((f) => fs.existsSync(f));
  const hits = targets.filter((f) => {
    const rel = path.relative(ROOT, f);
    return BANNED.test(rel) || BANNED.test(fs.readFileSync(f, 'utf8').replace(ALLOWED, ''));
  });
  assert.deepStrictEqual(hits.map((f) => path.relative(ROOT, f)), []);
});

test('plan or phase references do not appear in code comments', () => {
  const files = ['lib', 'bin'].flatMap((d) => walk(path.join(ROOT, d)));
  const hits = files.filter((f) => /\bphase[- ]?\d|\bplan\.md\b/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(hits.map((f) => path.relative(ROOT, f)), []);
});
