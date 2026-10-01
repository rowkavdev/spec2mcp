import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

test('cookie object schema keeps required properties, nested types and additionalProperties', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Cookie objects', version: '1' }, components: { schemas: {} },
    paths: { '/': { get: { operationId: 'get', parameters: [{ name: 'prefs', in: 'cookie', schema: {
      type: 'object', properties: { level: { type: 'integer', minimum: 1, maximum: 5 }, mode: { type: 'string', enum: ['safe'] } },
      required: ['level'], additionalProperties: false,
    } }], responses: { '200': { description: 'ok' } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(buildManifest(doc).tools[0]!.inputSchema);
  assert.ok(validate({ prefs: { level: 3, mode: 'safe' } }));
  for (const prefs of [{}, { level: 999 }, { level: 1.5 }, { level: 3, extra: true }, { level: 3, mode: 'unsafe' }]) {
    assert.equal(validate({ prefs }), false, JSON.stringify(prefs));
  }
});
