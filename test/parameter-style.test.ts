import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

test('#83 manifest preserves parameter styles and explode from both component and inline definitions', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Styles', version: '1' },
    components: { schemas: {}, parameters: {
      tags: { name: 'tags', in: 'query', style: 'form', explode: false, schema: { type: 'array', items: { type: 'string' } } },
    } },
    paths: { '/things/{ids}': { get: {
      operationId: 'getThings',
      parameters: [
        { $ref: '#/components/parameters/tags' },
        { name: 'ids', in: 'path', required: true, style: 'label', explode: true, schema: { type: 'array', items: { type: 'string' } } },
        { name: 'X-Ids', in: 'header', style: 'simple', explode: false, schema: { type: 'array', items: { type: 'string' } } },
      ],
      responses: { '200': { description: 'OK' } },
    } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const args = buildManifest(doc).tools[0]!.args;
  assert.deepEqual(args.filter((arg) => arg.location !== 'body').map(({ name, style, explode, schema }) => ({ name, style, explode, type: schema.type })), [
    { name: 'ids', style: 'label', explode: true, type: 'array' },
    { name: 'tags', style: 'form', explode: false, type: 'array' },
    { name: 'X-Ids', style: 'simple', explode: false, type: 'array' },
  ]);
});

test('#108 manifest preserves allowReserved on referenced query parameter', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Reserved', version: '1' },
    components: { schemas: {}, parameters: { q: { name: 'q', in: 'query', allowReserved: true, schema: { type: 'string' } } } },
    paths: { '/search': { get: { operationId: 'search', parameters: [{ $ref: '#/components/parameters/q' }],
      responses: { '200': { description: 'OK' } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  assert.equal(buildManifest(doc).tools[0]!.args[0]?.allowReserved, true);
});

const { compileOutputValidator } = (await import(
  fileURLToPath(new URL('../runtime/server.mjs', import.meta.url))
)) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

test('#130 numeric and boolean parameter enums keep their primitive types in the input schema', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Enums', version: '1' },
    components: { schemas: {} },
    paths: { '/items': { get: {
      operationId: 'getItems',
      parameters: [
        { name: 'limit', in: 'query', required: true, schema: { type: 'integer', enum: [1, 2] } },
        { name: 'verbose', in: 'query', schema: { type: 'boolean', enum: [true, false] } },
        { name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'integer', enum: [1, 2] } } },
        { name: 'mode', in: 'query', schema: { type: 'string', enum: ['1', '2'] } },
      ],
      responses: { '200': { description: 'OK' } },
    } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const schema = buildManifest(doc).tools[0]!.inputSchema as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(schema.properties.limit, { type: 'number', enum: [1, 2] });
  assert.deepEqual(schema.properties.verbose, { type: 'boolean', enum: [true, false] });
  assert.deepEqual(schema.properties.ids, { type: 'array', items: { type: 'number', enum: [1, 2] } });
  assert.deepEqual(schema.properties.mode, { type: 'string', enum: ['1', '2'] }, 'string enums keep string values');
  const validate = compileOutputValidator(schema);
  assert.ok(validate({ limit: 1 }), 'numeric enum member accepted');
  assert.ok(validate({ limit: 2, verbose: true, ids: [1, 2], mode: '1' }), 'mixed typed and string enums accepted');
  assert.ok(!validate({ limit: 3 }), 'value outside the enum rejected');
  assert.ok(!validate({ limit: '1' }), 'string no longer satisfies a numeric enum');
});
