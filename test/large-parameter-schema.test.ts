import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

for (const location of ['query', 'header', 'cookie']) {
  test(`large JSON ${location} parameter keeps its tool with a bounded warning`, async () => {
    const doc = {
      openapi: '3.0.3', info: { title: 'Large parameters', version: '1' }, components: { schemas: {} },
      paths: { '/': { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, required: true, content: { 'application/json': { schema: {
        type: 'object', properties: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`field${i}`, { type: 'string' }])),
      } } } }], responses: { '200': { description: 'ok' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const manifest = buildManifest(doc);
    assert.equal(manifest.tools.length, 1);
    const arg = manifest.tools[0]!.args[0]!;
    assert.equal(arg.required, true);
    assert.equal(arg.parameterContentType, 'application/json');
    assert.equal(arg.schema.type, 'object');
    assert.match(manifest.warnings!.join('\n'), new RegExp(`${location} parameter "filter".*exceeds.*budget`));
    assert.ok(JSON.stringify(manifest.tools[0]!.inputSchema).length < 4096);
  });
}
