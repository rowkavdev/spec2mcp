import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
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
