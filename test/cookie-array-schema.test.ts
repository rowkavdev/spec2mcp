import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

test('cookie array items keep primitive compositions and their constraints', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Cookie array items', version: '1' }, components: { schemas: {} },
    paths: { '/': { get: { operationId: 'get', parameters: [{ name: 'values', in: 'cookie', schema: {
      type: 'array', minItems: 1, items: { oneOf: [{ type: 'integer', minimum: 1, maximum: 5 }, { type: 'string', pattern: '^safe$' }] },
    } }], responses: { '200': { description: 'ok' } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(buildManifest(doc).tools[0]!.inputSchema);
  assert.equal(validate({ values: [3, 'safe'] }), true, 'valid mixed primitive cookie array');
  for (const values of [[], [1.5], [999], ['unsafe'], [true], [null]]) {
    assert.equal(validate({ values }), false, JSON.stringify(values));
  }
});
