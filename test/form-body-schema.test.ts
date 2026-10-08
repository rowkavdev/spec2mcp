import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(fileURLToPath(new URL('../runtime/server.mjs', import.meta.url)));

for (const referenced of [false, true]) {
  test(`form body retains required fields and constraints (${referenced ? 'ref' : 'inline'})`, async () => {
    const schema = { type: 'object', required: ['count'], additionalProperties: false, properties: {
      count: { type: 'integer', minimum: 1, maximum: 5 }, mode: { type: 'string', pattern: '^safe$' },
    } };
    const doc = { openapi: '3.0.3', info: { title: 'Form', version: '1' }, components: { schemas: { Form: schema } }, paths: {
      '/form': { post: { operationId: 'sendForm', requestBody: { required: true, content: {
        'application/x-www-form-urlencoded': { schema: referenced ? { $ref: '#/components/schemas/Form' } : schema },
      } }, responses: { '204': { description: 'OK' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const tool = buildManifest(doc).tools[0]!;
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
    assert.equal(validate({ body: { count: 3, mode: 'safe' } }), true);
    assert.equal(validate({ body: {} }), false, 'inner required field');
    assert.equal(validate({ body: { count: 999 } }), false, 'numeric constraint');
    assert.equal(validate({ body: { count: 3, mode: 'unsafe' } }), false, 'string pattern');
    assert.equal(validate({ body: { count: 3, extra: 1 } }), false, 'additional properties');
  });
}

test('optional form body and declared nullable fields stay usable', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Nullable Form', version: '1' }, components: { schemas: {} }, paths: {
    '/form': { post: { operationId: 'sendForm', requestBody: { content: {
      'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['name'], properties: {
        name: { type: 'string', nullable: true },
      } } },
    } }, responses: { '204': { description: 'OK' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
  assert.equal(validate({}), true);
  assert.equal(validate({ body: { name: null } }), true);
  assert.equal(validate({ body: {} }), false);
  assert.equal(validate({ body: { name: 42 } }), false);
});
