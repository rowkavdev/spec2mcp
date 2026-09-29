import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

const objectBody = { content: { 'application/json': { schema: {
  type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
} } } };
const arrayBody = { content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } };
const multipartBody = { content: { 'multipart/form-data': { schema: {
  type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'],
} } } };
const rawBody = { content: { 'text/plain': { schema: { type: 'string' } } } };
const cases = [objectBody, arrayBody, multipartBody, rawBody];

test('optional body leaves even its inner required fields optional at tool level', async () => {
  const paths: Record<string, unknown> = {};
  cases.forEach((body, i) => {
    paths[`/optional${i}`] = { post: { operationId: `optional${i}`, requestBody: body, responses: { '204': { description: 'OK' } } } };
    paths[`/required${i}`] = { post: { operationId: `required${i}`, requestBody: { ...body, required: true }, responses: { '204': { description: 'OK' } } } };
  });
  const doc = { openapi: '3.0.3', info: { title: 'Bodies', version: '1' },
    components: { schemas: {} }, paths } as unknown as OpenAPIV3.Document;
  await init(doc);
  const tools = buildManifest(doc).tools;
  for (let i = 0; i < cases.length; i++) {
    const optional = tools.find((t) => t.name === `optional${i}`)!;
    const required = tools.find((t) => t.name === `required${i}`)!;
    assert.ok(optional.args.length > 0, `body ${i} exposes an argument`);
    assert.deepEqual(optional.inputSchema.required, [], `optional body ${i}`);
    assert.equal(optional.args.every((a) => !a.required), true);
    assert.ok((required.inputSchema.required as string[]).length > 0, `required body ${i}`);
  }
});
