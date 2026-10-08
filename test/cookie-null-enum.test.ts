import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

test('cookie null enum members survive scalar and array schema mapping', async () => {
  const doc = { openapi: '3.1.0', info: { title: 'Null enum', version: '1' }, components: { schemas: {} }, paths: {
    '/': { get: { operationId: 'get', parameters: [
      { name: 'scalar', in: 'cookie', schema: { type: 'null', enum: [null] } },
      { name: 'values', in: 'cookie', schema: { type: 'array', items: { type: 'null', enum: [null] } } },
    ], responses: { '200': { description: 'ok' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
  assert.equal(validate({ scalar: null, values: [null] }), true);
  assert.equal(validate({ scalar: 'null' }), false);
  assert.equal(validate({ values: [0] }), false);
});
