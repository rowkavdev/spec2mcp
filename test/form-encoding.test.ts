import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

test('#86 manifest keeps per-property form encoding, including referenced request bodies', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Forms', version: '1' },
    components: { schemas: {}, requestBodies: { payload: {
      required: true, content: { 'application/x-www-form-urlencoded': {
        schema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } },
        encoding: { tags: { style: 'form', explode: false } },
      } },
    } } },
    paths: { '/form': { post: {
      operationId: 'sendForm', requestBody: { $ref: '#/components/requestBodies/payload' },
      responses: { '200': { description: 'OK' } },
    } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.deepEqual(tool.formEncoding, { tags: { style: 'form', explode: false } });
  assert.equal(tool.args[0]?.schema.type, 'object');
});
