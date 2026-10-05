import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

for (const schema of [{ type: 'object' }, {}]) {
  test(`required unconstrained JSON body is not discarded: ${JSON.stringify(schema)}`, async () => {
    const doc = { openapi: '3.0.3', info: { title: 'Required body', version: '1' }, components: { schemas: {} },
      paths: { '/x': { post: { operationId: 'x', requestBody: { required: true, content: { 'application/json': { schema } } },
        responses: { '204': { description: 'OK' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const tool = buildManifest(doc).tools[0]!;
    assert.equal(tool.contentType, 'application/json');
    assert.deepEqual(tool.inputSchema.required, ['body']);
    assert.equal(tool.args[0]?.required, true);
    assert.deepEqual(tool.args[0]?.apiFieldPath, []);
  });
}
