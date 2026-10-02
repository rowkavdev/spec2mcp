import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

const { compileOutputValidator } = (await import(fileURLToPath(new URL('../runtime/server.mjs', import.meta.url)))) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

test('object query and header parameters keep properties, required keys and bounds', async () => {
  const filter = { type: 'object', required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] }, n: { type: 'integer', minimum: 1 } } };
  const doc = {
    openapi: '3.0.3', info: { title: 'Object params', version: '1' }, components: { schemas: {} },
    paths: { '/x': { get: {
      operationId: 'getX',
      parameters: [
        { name: 'filter', in: 'query', style: 'deepObject', explode: true, description: 'Filter.', schema: filter },
        { name: 'X-Filter', in: 'header', schema: filter },
      ],
      responses: { '200': { description: 'OK' } },
    } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const schema = buildManifest(doc).tools[0]!.inputSchema as { properties: Record<string, Record<string, unknown>> };
  for (const name of ['filter', 'X-Filter']) {
    const property = schema.properties[name]!;
    assert.deepEqual(Object.keys(property.properties as object).sort(), ['a', 'n'], name);
    assert.deepEqual(property.required, ['a'], name);
  }
  assert.equal(schema.properties.filter!.description, 'Filter.');
  const validate = compileOutputValidator(schema);
  assert.ok(validate({ filter: { a: 'x', n: 2 } }));
  assert.equal(validate({ filter: { n: 2 } }), false);
  assert.equal(validate({ filter: { a: 'z' } }), false);
  assert.equal(validate({ filter: { a: 'x', n: 0 } }), false);
});
