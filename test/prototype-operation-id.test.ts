import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

for (const operationId of ['constructor', 'toString', '__proto__']) {
  test(`operationId ${operationId} does not collide with object prototype keys`, async () => {
    const doc = { openapi: '3.0.3', info: { title: 'Prototype IDs', version: '1' }, components: { schemas: {} },
      paths: { '/': { get: { operationId, responses: { '200': { description: 'ok' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    assert.equal(buildManifest(doc).tools[0]!.operationId, operationId);
  });
}
