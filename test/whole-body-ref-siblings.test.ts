import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
const oracle = new Ajv2020({ strict: false, validateFormats: false });
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };
for (const version of ['3.0.3', '3.1.0']) for (const media of ['application/json', 'application/vnd.test+json']) {
 for (const route of ['required object', 'optional object', 'root array']) for (const [label, leaf, good, bad31] of [
  ['bound', { $ref: '#/components/schemas/Score', maximum: 5 }, 3, 9],
  ['chain', { $ref: '#/components/schemas/Outer' }, 3, 9],
  ['enum', { $ref: '#/components/schemas/Score', enum: [3] }, 3, 9],
  ['negation', { $ref: '#/components/schemas/Score', not: { $ref: '#/components/schemas/Middle' } }, 9, 3],
  ['anyOf', { $ref: '#/components/schemas/Score', anyOf: [{ $ref: '#/components/schemas/Middle' }, { const: 10 }] }, 3, 9],
  ['oneOf', { $ref: '#/components/schemas/Score', oneOf: [{ $ref: '#/components/schemas/Middle' }, { const: 10 }] }, 10, 9],
 ] as const) {
  test(`${version} ${media} ${route} preserves ${label}`, async () => {
   const schemas = { Score: { type: 'integer', minimum: 0 }, Middle: { $ref: '#/components/schemas/Score', maximum: 5 }, Outer: { $ref: '#/components/schemas/Middle', minimum: 2 } };
   const array = { type: 'array', items: { type: 'array', items: leaf } };
   const schema = route === 'root array' ? array : { type: 'object', required: ['tags'], properties: { tags: array } };
   const required = route !== 'optional object';
   const doc = { openapi: version, info: { title: 'Whole-body sweep', version: '1' }, components: { schemas }, paths: { '/': { post: {
    operationId: 'post', requestBody: { required, content: { [media]: { schema } } }, responses: { '200': { description: 'ok' } },
   } } } } as unknown as OpenAPIV3.Document;
   await init(doc);
   const tool = buildManifest(doc).tools[0]!;
   assert.equal(tool.args[0]!.name, 'body');
   assert.deepEqual(tool.args[0]!.apiFieldPath, []);
   const wrap = (value: unknown) => route === 'root array' ? [[value]] : { tags: [[value]] };
   const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
   assert.equal(validate({ body: wrap(good) }), true);
   assert.equal(validate({}), !required);
   if (version === '3.1.0') {
    const original = oracle.compile({ ...schema, components: { schemas } });
    assert.equal(original(wrap(good)), true);
    assert.equal(original(wrap(bad31)), false);
    assert.equal(validate({ body: wrap(bad31) }), false);
   }
  });
 }
}

for (const route of ['required object', 'root array']) for (const [label, leaf] of [
 ['oversized negation', { not: { const: 'x'.repeat(300000) } }],
 ['missing reference', { not: { $ref: '#/components/schemas/Missing' } }],
 ['cycle', { not: { $ref: '#/components/schemas/Loop' } }],
 ['depth', { not: (() => { let node: unknown = { const: 3 }; for (let i = 0; i < 20; i++) node = { allOf: [node] }; return node; })() }],
] as const) {
 test(`3.1 ${route} fallback ${label} stays widened with warning`, async () => {
  const array = { type: 'array', items: { type: 'array', items: leaf } };
  const schema = route === 'root array' ? array : { type: 'object', required: ['tags'], properties: { tags: array } };
  const doc = { openapi: '3.1.0', info: { title: 'Fallback', version: '1' }, components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } }, paths: { '/': { post: {
   operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema } } }, responses: { '200': { description: 'ok' } },
  } } } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const manifest = buildManifest(doc);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
  assert.equal(validate({ body: route === 'root array' ? [[3]] : { tags: [[3]] } }), true);
  assert.ok(manifest.warnings?.length);
 });
}
