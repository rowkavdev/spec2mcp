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

test('#144 required empty JSON and multipart objects retain a valid empty-body path', async () => {
  const paths: Record<string, unknown> = {};
  for (const [media, suffix] of [['application/json', 'json'], ['multipart/form-data', 'multipart']] as const) {
    const body = { content: { [media]: { schema: { type: 'object', properties: { note: { type: 'string' } } } } } };
    paths[`/${suffix}`] = { post: { operationId: suffix, requestBody: { ...body, required: true }, responses: { '204': { description: 'OK' } } } };
    paths[`/optional-${suffix}`] = { post: { operationId: `optional${suffix}`, requestBody: body, responses: { '204': { description: 'OK' } } } };
  }
  const doc = { openapi: '3.0.3', info: { title: 'Empty Bodies', version: '1' }, components: { schemas: {} }, paths } as unknown as OpenAPIV3.Document;
  await init(doc);
  for (const tool of buildManifest(doc).tools) {
    assert.equal(tool.requiredEmptyObject === true, !tool.name.startsWith('optional'), tool.name);
  }
});

test('#144 required object where {} is invalid falls back to a required whole-body argument', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Empty Invalid', version: '1' }, components: { schemas: {} }, paths: {
    '/min': { post: { operationId: 'minProps', requestBody: { required: true, content: { 'application/json': { schema:
      { type: 'object', minProperties: 1, properties: { note: { type: 'string' } } } } } }, responses: { '204': { description: 'OK' } } } },
    '/min-multipart': { post: { operationId: 'minPropsMultipart', requestBody: { required: true, content: { 'multipart/form-data': { schema:
      { type: 'object', minProperties: 1, properties: { note: { type: 'string' } } } } } }, responses: { '204': { description: 'OK' } } } },
    '/allo': { post: { operationId: 'allOfMin', requestBody: { required: true, content: { 'application/json': { schema:
      { allOf: [{ type: 'object', properties: { note: { type: 'string' } } }, { type: 'object', minProperties: 1 }] } } } }, responses: { '204': { description: 'OK' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const tools = buildManifest(doc).tools;
  const min = tools.find((t) => t.name === 'min_props');
  assert.ok(min);
  assert.equal(min.requiredEmptyObject, undefined);
  const bodyArgs = min.args.filter((a) => a.location === 'body');
  assert.equal(bodyArgs.length, 1);
  const whole = bodyArgs[0];
  assert.ok(whole);
  assert.equal(whole.required, true);
  assert.equal((whole.apiFieldPath ?? []).length, 0);
  assert.equal((whole.schema as Record<string, unknown>).minProperties, 1);
  const multi = tools.find((t) => t.name === 'min_props_multipart');
  assert.ok(multi);
  assert.equal(multi.requiredEmptyObject, undefined);
  assert.ok(!multi.args.some((a) => a.location === 'body' && a.required));
  const composed = tools.find((t) => t.name === 'all_of_min');
  assert.ok(composed);
  assert.equal(composed.requiredEmptyObject, undefined);
});
