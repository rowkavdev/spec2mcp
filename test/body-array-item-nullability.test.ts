import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

test('flattened JSON body array fields retain nullable item types', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Nullable body items', version: '1' }, components: { schemas: {} }, paths: {
    '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['values'], properties: {
        values: { type: 'array', items: { type: 'integer', nullable: true, minimum: 1 } },
      },
    } } } }, responses: { '200': { description: 'ok' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
  assert.equal(validate({ values: [2, null] }), true);
  assert.equal(validate({ values: ['wrong'] }), false);
});
