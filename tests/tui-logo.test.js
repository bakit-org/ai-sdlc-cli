'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bannerFor, renderLogo, pixels } = require('../lib/tui/logo');
const { SLIM, THICK } = require('../lib/tui/logo-fonts');
const { visibleWidth, stripAnsi } = require('../lib/tui/text-width');

const widest = (lines) => Math.max(...lines.map(visibleWidth));

test('banner size follows the terminal width', () => {
  const thick = bannerFor(140, 3);
  const wide = bannerFor(110, 3);
  const compact = bannerFor(70, 3);
  assert.strictEqual(thick.length, 10, 'thick font: 9 rows plus the shadow row');
  assert.strictEqual(wide.length, 8, '1-pixel font: 7 rows plus the shadow row');
  assert.strictEqual(compact.length, 4, 'compact: two pixel rows per line');
  assert.ok(widest(thick) > widest(wide) && widest(wide) > widest(compact));
});

test('size boundaries: 120 thick, 100 wide, 50 compact, below that one line', () => {
  assert.strictEqual(bannerFor(120, 3).length, 10);
  assert.strictEqual(bannerFor(119, 3).length, 8);
  assert.strictEqual(bannerFor(100, 3).length, 8);
  assert.strictEqual(bannerFor(99, 3).length, 4);
  assert.strictEqual(bannerFor(50, 3).length, 4);
  const tiny = bannerFor(49, 3);
  assert.strictEqual(tiny.length, 1);
  assert.strictEqual(stripAnsi(tiny[0]), '> AI-SDLC');
});

test('every variant fits inside the width that selects it', () => {
  for (const cols of [50, 60, 99, 100, 119, 120, 160]) {
    for (const level of [0, 1, 3]) assert.ok(widest(bannerFor(cols, level)) <= cols - 2, `${cols} columns, level ${level}`);
  }
});

test('without colour support the banner is one plain text line, whatever the width', () => {
  for (const cols of [40, 80, 130]) assert.deepStrictEqual(bannerFor(cols, 0), ['> AI-SDLC']);
});

test('without unicode the banner is the text line too (block characters are not safe)', () => {
  assert.deepStrictEqual(bannerFor(130, 3, { unicode: false }).map(stripAnsi), ['> AI-SDLC']);
  assert.deepStrictEqual(bannerFor(130, 1, { unicode: false }).map(stripAnsi), ['> AI-SDLC']);
});

test('truecolor banner runs from blue through purple to pink with a dimmer shadow', () => {
  const text = bannerFor(110, 3).join('\n');
  assert.match(text, /\x1b\[38;2;71;150;228m/, 'blue at the left edge');
  assert.match(text, /\x1b\[38;2;19\d;10\d;1\d\dm/, 'pink at the right edge');
  const shadow = [...text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => Number(m[1]) + Number(m[2]) + Number(m[3]));
  assert.ok(Math.min(...shadow) < 250 && Math.max(...shadow) > 400, 'shadow pixels are darker than letter pixels');
});

test('16-colour banner uses only basic colour codes; colourless rendering has none', () => {
  const basic = bannerFor(110, 1).join('');
  assert.doesNotMatch(basic, /38;2;/);
  assert.match(basic, /\x1b\[9[145]m/);
  assert.strictEqual(renderLogo({ level: 0, scale: 2 }).join('').includes('\x1b'), false);
  assert.strictEqual(renderLogo({ level: 0, scale: 1 }).join('').includes('\x1b'), false);
});

test('fonts: every glyph has a consistent size and the thick font has 2-pixel strokes', () => {
  for (const font of [SLIM, THICK]) {
    const rows = new Set(Object.values(font).map((g) => g.length));
    assert.strictEqual(rows.size, 1);
    for (const glyph of Object.values(font)) assert.strictEqual(new Set(glyph.map((r) => r.length)).size, 1);
  }
  assert.strictEqual(THICK.L[0], '##....', 'the vertical stroke of L is two pixels wide');
  assert.strictEqual(SLIM.L[0], '#....');
  assert.strictEqual(pixels('>AI-SDLC', THICK).length, 10);
  assert.throws(() => pixels('?', SLIM), /./);
});
