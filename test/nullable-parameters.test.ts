import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

const cases: [string, Record<string, unknown>, unknown][] = [
  ['string', { type: 'string' }, 'a'],
  ['integer', { type: 'integer' }, 3],
  ['boolean', { type: 'boolean' }, true],
  ['array', { type: 'array', items: { type: 'string' } }, ['a']],
];

for (const location of ['query', 'header'] as const) {
  for (const [name, schema, value] of cases) {
    test(`a nullable ${name} ${location} parameter accepts null`, async () => {
      const doc = {
        openapi: '3.0.3', info: { title: 'Nullable parameters', version: '1' }, components: { schemas: {} },
        paths: { '/': { get: { operationId: 'get', parameters: [{ name: 'v', in: location, schema: { ...schema, nullable: true } }], responses: { '200': { description: 'ok' } } } } },
      } as unknown as OpenAPIV3.Document;
      await init(doc);
      const validate = compileOutputValidator(buildManifest(doc).tools[0]!.inputSchema);
      assert.equal(validate({ v: null }), true, 'null');
      assert.equal(validate({ v: value }), true, 'declared value');
      assert.equal(validate({ v: { not: 'valid' } }), false, 'object stays rejected');
    });
  }
}

test('nullable array items accept null, and a non-nullable parameter still rejects it', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Nullable items', version: '1' }, components: { schemas: {} },
    paths: { '/': { get: { operationId: 'get', parameters: [
      { name: 'items', in: 'query', schema: { type: 'array', items: { type: 'string', nullable: true } } },
      { name: 'plain', in: 'query', schema: { type: 'string' } },
    ], responses: { '200': { description: 'ok' } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(buildManifest(doc).tools[0]!.inputSchema);
  assert.equal(validate({ items: ['a', null] }), true);
  assert.equal(validate({ plain: null }), false);
});
