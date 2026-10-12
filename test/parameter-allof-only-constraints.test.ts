import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

for (const [label, schema, good, bad] of [
  ['constraint-only branches', { type: 'integer', allOf: [{ minimum: 2 }, { maximum: 5 }] }, 3, [2.5, 1, 6]],
  ['root constraint intersection', { type: 'integer', minimum: 1, allOf: [{ type: 'integer', minimum: 2 }] }, 3, [1]],
  ['root enum intersection', { type: 'integer', enum: [1, 2], allOf: [{ type: 'integer', enum: [2, 3] }] }, 2, [1, 3]],
  ['integer enum', { allOf: [{ type: 'integer', enum: [2, 3], minimum: 2 }] }, 2, [2.5, 4]],
  ['mixed numeric branches', { allOf: [{ type: 'number', minimum: 2 }, { type: 'integer', maximum: 5 }] }, 3, [2.5, 1, 6]],
  ['two patterns', { allOf: [{ type: 'string', pattern: '^s' }, { type: 'string', pattern: 'e$' }] }, 'safe', ['sail', 'wee']],
  ['length alone', { allOf: [{ type: 'string', minLength: 4, maxLength: 4 }] }, 'safe', ['s', 'safee']],
  ['nullable flat default', { nullable: true, default: 3, allOf: [{ type: 'integer', minimum: 2 }] }, null, [1, 2.5]],
  ['integer bounds', { allOf: [{ type: 'integer', minimum: 2, maximum: 5 }] }, 3, [2.5, 1, 6]],
  ['string constraints', { allOf: [{ type: 'string', pattern: '^safe$', minLength: 4, maxLength: 4 }] }, 'safe', ['unsafe', 's', 'safee']],
  ['array integer items', { type: 'array', items: { allOf: [{ type: 'integer', minimum: 2, maximum: 5 }] } }, [3], [[2.5], [1], [6]]],
  ['array string items', { type: 'array', items: { allOf: [{ type: 'string', pattern: '^safe$', minLength: 4 }] } }, ['safe'], [['unsafe'], ['s']]],
] as const) {
  test(`allOf-only query parameters retain ${label}`, async () => {
    const doc = { openapi: '3.0.3', info: { title: 'AllOf constraints', version: '1' }, components: { schemas: {} }, paths: {
      '/': { get: { operationId: 'get', parameters: [{ name: 'value', in: 'query', schema }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
    assert.equal(validate({ value: good }), true);
    for (const value of bad) assert.equal(validate({ value }), false, JSON.stringify(value));
  });
}

test('allOf-only recovery preserves default and excludes branch format', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Flat compatibility', version: '1' }, components: { schemas: {} }, paths: {
    '/': { get: { operationId: 'get', parameters: [{ name: 'value', in: 'query', schema: {
      nullable: true, default: 3, allOf: [{ type: 'integer', minimum: 2, format: 'int32' }],
    } }], responses: { '200': { description: 'ok' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  assert.deepEqual(buildManifest(doc).tools[0]!.args[0]!.schema, { type: ['integer', 'null'], minimum: 2, default: 3 });
});

test('allOf-only recovery leaves type-array branches on the existing path', async () => {
  const doc = { openapi: '3.1.0', info: { title: 'Type arrays', version: '1' }, components: { schemas: {} }, paths: {
    '/': { get: { operationId: 'get', parameters: [{ name: 'value', in: 'query', schema: {
      allOf: [{ type: ['integer'], minimum: 2 }],
    } }], responses: { '200': { description: 'ok' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  assert.deepEqual(buildManifest(doc).tools[0]!.args[0]!.schema, { type: 'string' });
});
