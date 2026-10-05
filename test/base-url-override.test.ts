import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

test('an explicit base URL override bypasses unusable root server variables', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Override', version: '1' }, components: { schemas: {} },
    servers: [{ url: 'https://{hostname}/v1' }],
    paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'OK' } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  assert.throws(() => buildManifest(doc), /Server variable "hostname" has no default/);
  const manifest = buildManifest(doc, { baseUrl: 'https://override.example/v2' });
  assert.equal(manifest.baseUrl, 'https://override.example/v2');
  assert.equal(manifest.tools.length, 1);
});
