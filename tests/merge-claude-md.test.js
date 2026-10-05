'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { upsertBlock, removeBlock, BEGIN, END } = require('../lib/merge-claude-md');

test('upsert then remove returns the original text for many shapes', () => {
  for (const original of ['', '\n', 'a', 'a\n', 'a\n\n', 'a\r\nb\r\n', 'a\r\nb', '# T\n\n- x\n']) {
    const { text, info } = upsertBlock(original, 'body line\n', null);
    assert.ok(text.includes(BEGIN) && text.includes(END));
    assert.strictEqual(removeBlock(text, info).text, original, JSON.stringify(original));
  }
});

test('refresh replaces only what is between the markers', () => {
  const first = upsertBlock('top\n', 'one\n', null);
  const edited = first.text.replace('top\n', 'top\nmore top\n') + 'tail\n';
  const second = upsertBlock(edited, 'two\n', first.info);
  assert.match(second.text, /more top/);
  assert.match(second.text, /two/);
  assert.doesNotMatch(second.text, /one/);
  assert.ok(second.text.endsWith('tail\n'));
});

test('an unbalanced marker pair is refused', () => {
  assert.throws(() => upsertBlock(`${BEGIN}\nx\n`, 'b', null), /unbalanced/);
  assert.throws(() => upsertBlock(`${END}\n${BEGIN}\n`, 'b', null), /unbalanced/);
});

test('a created file that only held the block is reported as deletable', () => {
  const { text, info } = upsertBlock(null, 'b\n', null);
  assert.strictEqual(removeBlock(text, info).text, null);
});
