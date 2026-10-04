import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';
import { operationIncluded } from '../src/filter.js';

const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));

test('includes are OR, excludes win, globs match whole operationId', () => {
  assert.equal(operationIncluded('listPets', ['pets'], { include: ['list*', 'other'], exclude: ['operation:*Pets'] }), false);
  assert.equal(operationIncluded('listPets', ['pets'], { include: ['tag:pets'] }), true);
  assert.equal(operationIncluded('listPets', ['pets'], { include: ['pets'], exclude: ['tag:pets'] }), false);
  assert.equal(operationIncluded('listPets', [], { include: ['Pets'] }), false);
  assert.equal(operationIncluded('getPet', [], { include: ['operation:get?et'] }), true);
  assert.equal(operationIncluded('getPet', [], { include: ['operation:*', 'tag:irrelevant'] }), true);
});

test('manifest filters resolved operations before tool-name deduplication', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const result = buildManifest(doc, { include: ['list*'], exclude: ['operation:listPets'] });
  assert.deepEqual(result.tools.map((tool) => tool.name), ['list_pets_2']);
  assert.equal(result.tools[0]?.operationId, 'listPets_2');
});

test('tag selector filters using original OpenAPI tags', async () => {
  const doc = await loadSpec(PETSTORE);
  (doc.paths['/pets']!.get!).tags = ['catalog'];
  await init(doc);
  const result = buildManifest(doc, { include: ['tag:catalog'] });
  assert.deepEqual(result.tools.map((tool) => tool.operationId), ['listPets']);
  assert.deepEqual(result.tools[0]?.tags, ['catalog']);
});

test('operation globs match the whole identifier including newline and Unicode characters', () => {
  assert.equal(operationIncluded('get\n', [], { include: ['operation:get'] }), false);
  assert.equal(operationIncluded('get\nitem', [], { include: ['operation:get*'] }), true);
  assert.equal(operationIncluded('get😀', [], { include: ['operation:get?'] }), true);
});
