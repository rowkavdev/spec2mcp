import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

const { compileOutputValidator } = (await import(fileURLToPath(new URL('../runtime/server.mjs', import.meta.url)))) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

test('#247 cookie parameters keep declared constraints', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Cookie limits', version: '1' }, components: { schemas: {} },
    paths: { '/x': { get: {
      operationId: 'getX',
      parameters: [
        { name: 'level', in: 'cookie', schema: { type: 'integer', minimum: 1, maximum: 5 } },
        { name: 'mode', in: 'cookie', schema: { type: 'string', pattern: '^safe$', minLength: 4 } },
      ],
      responses: { '200': { description: 'OK' } },
    } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(buildManifest(doc).tools[0]!.inputSchema);
  assert.ok(validate({ level: 3, mode: 'safe' }));
  assert.equal(validate({ level: 999, mode: 'safe' }), false);
  assert.equal(validate({ level: 3, mode: 'bad' }), false);
});
