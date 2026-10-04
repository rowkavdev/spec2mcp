import type { OpenAPIV3 } from 'openapi-types';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { applyOverlays } from '../src/overlay.js';
import { loadOverlays, loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';
import { readProjectConfig, resolveConfig } from '../src/config.js';

const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const OVERLAY = fileURLToPath(new URL('./fixtures/curate-overlay.yaml', import.meta.url));

test('overlays rename, remove and re-describe tools before generation', async () => {
  const overlays = await loadOverlays([OVERLAY]);
  const doc = applyOverlays(await loadSpec(PETSTORE), overlays);
  await init(doc);
  const m = buildManifest(doc);
  const names = m.tools.map((t) => t.name);
  assert.ok(names.includes('fetch_pet'), 'renamed operationId drives the tool name');
  assert.ok(!names.includes('get_pet'), 'old name is gone');
  assert.ok(!names.includes('delete_pet'), 'removed operation produces no tool');
  assert.equal(m.tools.length, 6);
  assert.equal(m.tools.find((t) => t.name === 'list_pets')?.description, 'List every pet currently in the store.');
});

test('an overlay targeting a missing operationId fails loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-ov-'));
  try {
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, [
      'overlay: 1.0.0',
      'info: { title: bad, version: 1.0.0 }',
      'actions:',
      "  - target: $.paths.*[?(@.operationId=='noSuchOperation')]",
      '    update: { description: nope }',
    ].join('\n'));
    const spec = await loadSpec(PETSTORE);
    const overlays = await loadOverlays([bad]);
    assert.throws(() => applyOverlays(spec, overlays), /noSuchOperation/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a non-overlay file is rejected before Forge sees it', async () => {
  await assert.rejects(loadOverlays([PETSTORE]), /not an OpenAPI Overlay document/);
});

test('#50 removal deletes every matched sibling in multiple arrays', () => {
  const doc = {
    openapi: '3.0.0', info: { title: 'Arrays', version: '1' },
    paths: {
      '/a': { get: { tags: ['a', 'b', 'c', 'd'], security: [{ one: [] }, { two: [] }, { three: [] }] } },
      '/b': { get: { tags: ['x', 'y', 'z'], security: [{ four: [] }, { five: [] }] } },
    },
    servers: [{ url: 'https://one.example' }, { url: 'https://two.example' }, { url: 'https://three.example' }],
  } as unknown as Parameters<typeof applyOverlays>[0];
  const overlay = {
    name: 'array-removals',
    overlay: {
      overlay: '1.0.0', info: { title: 'Remove arrays', version: '1' },
      actions: [
        { target: '$.paths.*.get.tags[*]', remove: true },
        { target: '$.paths.*.get.security[*]', remove: true },
        { target: '$.servers[*]', remove: true },
      ],
    },
  } as unknown as Parameters<typeof applyOverlays>[1][number];
  applyOverlays(doc, [overlay]);
  assert.deepEqual(doc.paths['/a']?.get?.tags, []);
  assert.deepEqual(doc.paths['/b']?.get?.tags, []);
  assert.deepEqual(doc.paths['/a']?.get?.security, []);
  assert.deepEqual(doc.paths['/b']?.get?.security, []);
  assert.deepEqual(doc.servers, []);
});

test('#53 overlay updates reject prototype pollution at any depth without mutating the spec', () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    for (const update of [
      JSON.parse(`{"${key}":{"polluted":true}}`),
      JSON.parse(`{"description":"should not land","nested":{"${key}":{"polluted":true}}}`),
      JSON.parse(`{"items":[{"${key}":{"polluted":true}}]}`),
    ]) {
      const doc = {
        openapi: '3.0.0', info: { title: 'Safe', version: '1' },
        paths: { '/safe': { get: { operationId: 'safe' } } },
      } as unknown as Parameters<typeof applyOverlays>[0];
      const before = structuredClone(doc);
      const overlay = {
        name: 'hostile', overlay: {
          overlay: '1.0.0', info: { title: 'Hostile', version: '1' },
          actions: [{ target: '$.paths.*.get', update }],
        },
      } as unknown as Parameters<typeof applyOverlays>[1][number];
      assert.throws(() => applyOverlays(doc, [overlay]), /forbidden key/);
      assert.deepEqual(doc, before);
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
    }
  }
});

test('#53 overlay update never merges into an inherited property', () => {
  const inherited = { description: { original: true } };
  const operation = Object.create(inherited) as Record<string, unknown>;
  operation.operationId = 'safe';
  const doc = {
    openapi: '3.0.0', info: { title: 'Safe', version: '1' },
    paths: { '/safe': { get: operation } },
  } as unknown as Parameters<typeof applyOverlays>[0];
  const overlay = {
    name: 'safe', overlay: {
      overlay: '1.0.0', info: { title: 'Safe', version: '1' },
      actions: [{ target: '$.paths.*.get', update: { description: { updated: true } } }],
    },
  } as unknown as Parameters<typeof applyOverlays>[1][number];
  applyOverlays(doc, [overlay]);
  assert.deepEqual(operation.description, { updated: true });
  assert.deepEqual(inherited.description, { original: true });
});

test('an overlay action that would change nothing fails instead of passing silently', () => {
  const run = (action: unknown) => applyOverlays({ a: { b: 1 } } as never, [{ name: 'o.yaml', overlay: { overlay: '1.0.0', actions: [action] } }] as never);
  assert.throws(() => run({ target: '$.a' }), /neither "update" nor "remove: true"/);
  assert.throws(() => run({ target: '$.a', remove: false }), /neither "update" nor "remove: true"/);
  assert.throws(() => run({ target: '$.a', remove: 'true' }), /"remove" must be true or false/);
  assert.throws(() => run({ target: '$', remove: true }), /cannot remove the document root/);
  assert.throws(() => run(null), /action 1 must be an object/);
  assert.doesNotThrow(() => run({ target: '$.a', remove: false, update: { c: 2 } }));
});

test('multi-target updates do not share inserted arrays between operations', () => {
  const doc = { openapi: '3.0.3', info: { title: 'Independent updates', version: '1' }, paths: {
    '/a': { get: { responses: {} } }, '/b': { get: { responses: {} } },
  } } as unknown as OpenAPIV3.Document;
  const update = { tags: ['shared'] };
  applyOverlays(doc, [{ name: 'test', overlay: { overlay: '1.0.0', info: { title: 'test', version: '1' }, actions: [
    { target: '$.paths.*.get', update },
    { target: "$.paths['/a'].get.tags[*]", remove: true },
  ] } }]);
  assert.deepEqual(doc.paths['/a']!.get!.tags, []);
  assert.deepEqual(doc.paths['/b']!.get!.tags, ['shared']);
  assert.deepEqual(update.tags, ['shared']);
});

for (const selector of ['[0]', '[1]', '[0,2]']) {
  test(`explicit array removal ${selector} splices values without leaving holes`, () => {
    const doc = { openapi: '3.0.3', info: { title: 'Index removal', version: '1' }, paths: {
      '/a': { get: { tags: ['a', 'b', 'c'], responses: {} } },
    } } as unknown as OpenAPIV3.Document;
    applyOverlays(doc, [{ name: 'test', overlay: { overlay: '1.0.0', info: { title: 'test', version: '1' }, actions: [
      { target: `$.paths['/a'].get.tags${selector}`, remove: true },
    ] } }]);
    const expected = selector === '[0]' ? ['b', 'c'] : selector === '[1]' ? ['a', 'c'] : ['b'];
    assert.deepEqual(doc.paths['/a']!.get!.tags, expected);
  });
}
