import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

for (const referenced of [false, true]) {
  test(`parameterized form media retains source schema and encoding (${referenced ? 'ref' : 'inline'})`, async () => {
    const schema = { type: 'object', required: ['count'], additionalProperties: false, properties: {
      count: { type: 'integer', minimum: 1, maximum: 5 }, tags: { type: 'array', items: { type: 'string' } },
    } };
    const bare = 'application/x-www-form-urlencoded';
    const parameterized = `${bare}; charset=utf-8`;
    const doc = {
      openapi: '3.0.3', info: { title: 'Forms', version: '1' }, components: { schemas: { Form: schema } },
      paths: Object.fromEntries([bare, parameterized].map((media, index) => [`/form-${index}`, { post: {
        operationId: `send${index}`, requestBody: { required: true, content: { [media]: {
          schema: referenced ? { $ref: '#/components/schemas/Form' } : schema,
          encoding: { tags: { style: 'form', explode: false } },
        } } }, responses: { '204': { description: 'OK' } },
      } }])),
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const tools = buildManifest(doc).tools;
    const control = tools.find(tool => tool.operationId === 'send0')!;
    const changed = tools.find(tool => tool.operationId === 'send1')!;
    assert.deepEqual(control.args[0]!.schema.required, ['count']);
    assert.deepEqual(changed.args, control.args);
    assert.deepEqual(changed.inputSchema, control.inputSchema);
    assert.deepEqual(changed.formEncoding, { tags: { style: 'form', explode: false } });
    assert.equal(changed.contentType, parameterized, 'preserve original media parameters on the wire');
  });
}
