import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

for (const location of ['query', 'header', 'cookie']) {
  test(`primitive ${location} composition branches retain declared nullability`, async () => {
    const doc = { openapi: '3.0.3', info: { title: 'Branch nullable', version: '1' }, components: { schemas: {} }, paths: {
      '/': { get: { operationId: 'get', parameters: [{ name: 'value', in: location, schema: {
        oneOf: [{ type: 'string', nullable: true }, { type: 'integer', minimum: 1 }],
      } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
    assert.equal(validate({ value: null }), true);
    assert.equal(validate({ value: 2 }), true);
    assert.equal(validate({ value: 'safe' }), true);
    assert.equal(validate({ value: 0 }), false);
    assert.equal(validate({ value: true }), false);
  });
}
