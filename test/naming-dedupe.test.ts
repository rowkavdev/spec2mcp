import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeNames } from '../src/naming.js';

test('reserves emitted names even when a later input already has the suffix', () => {
  assert.deepEqual(dedupeNames(['foo_bar', 'foo_bar', 'foo_bar_2']),
    ['foo_bar', 'foo_bar_2', 'foo_bar_2_2']);
  assert.deepEqual(dedupeNames(['foo_bar', 'foo_bar_2', 'foo_bar']),
    ['foo_bar', 'foo_bar_2', 'foo_bar_3']);
});

test('truncates for suffix length, even after the suffix grows to two digits', () => {
  const names = dedupeNames(Array(11).fill('x'.repeat(64)));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => name.length <= 64));
  assert.equal(names[9], `${'x'.repeat(61)}_10`);
  assert.equal(names[10], `${'x'.repeat(61)}_11`);
});

test('truncation-induced collisions with existing suffixes also advance', () => {
  const base = 'x'.repeat(64);
  assert.deepEqual(dedupeNames([base, `${'x'.repeat(62)}_2`, base]),
    [base, `${'x'.repeat(62)}_2`, `${'x'.repeat(62)}_3`]);
});
