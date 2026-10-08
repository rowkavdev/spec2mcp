import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

test('flattened JSON body leaves retain primitive source constraints', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Body limits', version: '1' }, components: { schemas: {} }, paths: {
    '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['count', 'mode'], properties: {
        count: { type: 'integer', minimum: 1, maximum: 5 }, mode: { type: 'string', pattern: '^safe$', minLength: 4 },
      },
    } } } }, responses: { '200': { description: 'ok' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
  assert.equal(validate({ count: 3, mode: 'safe' }), true);
  assert.equal(validate({ count: 999, mode: 'safe' }), false);
  assert.equal(validate({ count: 3, mode: 'unsafe' }), false);
});
