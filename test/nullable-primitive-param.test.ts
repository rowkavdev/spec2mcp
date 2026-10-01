import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

for (const location of ['query', 'header']) for (const type of ['string','integer','boolean','array']) {
  test(`nullable ${type} ${location} parameter retains null`, async () => {
    const doc = { openapi: '3.0.3', info: { title: 'Nullable', version: '1' }, components: { schemas: {} }, paths: {
      '/value': { get: { operationId: 'getValue', parameters: [{ name: 'filter', in: location, schema: { type, nullable: true, ...(type === 'array' ? { items: { type: 'string', nullable: true } } : {}) } }], responses: { '200': { description: 'ok' } } },
    } } };
    await init(doc as any);
    const schema = buildManifest(doc as any).tools[0]?.args[0]?.schema;
    assert.deepEqual(schema?.type, [type, 'null']);
    if (type === 'array') assert.deepEqual((schema?.items as any)?.type, ['string', 'null']);
  });
}

test('non-nullable query parameters stay non-nullable', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Plain', version: '1' }, components: { schemas: {} }, paths: {
    '/value': { get: { operationId: 'getValue', parameters: [{ name: 'filter', in: 'query', schema: { type: 'string', nullable: false } }], responses: { '200': { description: 'ok' } } },
  } } };
  await init(doc as any);
  assert.equal(buildManifest(doc as any).tools[0]?.args[0]?.schema.type, 'string');
});
