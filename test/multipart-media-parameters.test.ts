import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

for (const referenced of [false, true]) {
  test(`parameterized multipart media retains fields and constraints (${referenced ? 'ref' : 'inline'})`, async () => {
    const schema = { type: 'object', required: ['count'], additionalProperties: false, properties: {
      count: { type: 'integer', minimum: 1, maximum: 5 }, tags: { type: 'array', items: { type: 'string' } }, metadata: { type: 'object', properties: { id: { type: 'integer' } } },
    } };
    const bare = 'multipart/form-data';
    const parameterized = `${bare}; charset=utf-8`;
    const doc = {
      openapi: '3.0.3', info: { title: 'Forms', version: '1' }, components: { schemas: { Form: schema } },
      paths: Object.fromEntries([bare, parameterized].map((media, index) => [`/form-${index}`, { post: {
        operationId: `send${index}`, requestBody: { required: true, content: { [media]: {
          schema: referenced ? { $ref: '#/components/schemas/Form' } : schema,
          encoding: { metadata: { contentType: 'application/json' } },
        } } }, responses: { '204': { description: 'OK' } },
      } }])),
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const tools = buildManifest(doc).tools;
    const control = tools.find(tool => tool.operationId === 'send0')!;
    const changed = tools.find(tool => tool.operationId === 'send1')!;
    assert.equal(control.args.find(arg => arg.name === 'count')!.schema.minimum, 1);
    assert.deepEqual(changed.args, control.args);
    assert.deepEqual(changed.inputSchema, control.inputSchema);
    assert.equal(changed.args.find(arg => arg.name === 'count')!.required, true);
    assert.equal(changed.args.find(arg => arg.name === 'metadata')!.partContentType, 'application/json');
    assert.equal(changed.contentType, parameterized, 'preserve original media parameters on the wire');
  });
}
