import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

test('nonbinary multipart fields retain source validation constraints', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Multipart fields', version: '1' }, components: { schemas: {} },
    paths: { '/': { post: { operationId: 'upload', requestBody: { required: true, content: { 'multipart/form-data': { schema: {
      type: 'object', required: ['metadata', 'tags', 'count'], properties: {
        metadata: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false },
        tags: { type: 'array', minItems: 1, items: { type: 'string', enum: ['safe'] } },
        count: { type: 'integer', minimum: 1, maximum: 5 },
      },
    } } } }, responses: { '200': { description: 'ok' } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(buildManifest(doc).tools[0]!.inputSchema);
  const good = { metadata: { id: 3 }, tags: ['safe'], count: 2 };
  assert.equal(validate(good), true);
  for (const bad of [
    { ...good, metadata: {} }, { ...good, metadata: { id: 0 } }, { ...good, metadata: { id: 3, extra: true } },
    { ...good, tags: [] }, { ...good, tags: ['unsafe'] }, { ...good, count: 1.5 }, { ...good, count: 999 },
  ]) assert.equal(validate(bad), false, JSON.stringify(bad));
});
