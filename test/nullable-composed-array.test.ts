import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

for (const location of ['query', 'header']) {
  test(`nullable ${location} arrays with composed items retain outer nullability`, async () => {
    const doc = { openapi: '3.0.3', info: { title: 'Nullable array', version: '1' }, components: { schemas: {} }, paths: {
      '/': { get: { operationId: 'get', parameters: [{ name: 'values', in: location, schema: {
        type: 'array', nullable: true, minItems: 1, items: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
      } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
    assert.equal(validate({ values: null }), true);
    assert.equal(validate({ values: [2, 'safe'] }), true);
    assert.equal(validate({ values: [] }), false);
    assert.equal(validate({ values: [true] }), false);
  });
}
