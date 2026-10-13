import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
const oracle = new Ajv2020({ strict: false, validateFormats: false });
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};
for (const version of ['3.0.3', '3.1.0']) {
 for (const contentType of ['application/json', 'application/vnd.test+json']) {
  for (const required of [false, true]) {
   for (const [label, items, good, bad] of [
    ['object', { type: 'object', properties: { id: { type: 'integer', minimum: 2 } }, required: ['id'] }, [{ id: 3 }], [[{ id: 1 }], [{}]]],
    ['referenced object', { $ref: '#/components/schemas/Item' }, [{ id: 3 }], [[{ id: 1 }], [{}]]],
    ['nested object', { type: 'object', required: ['inner'], properties: { inner: { $ref: '#/components/schemas/Item' } } }, [{ inner: { id: 3 } }], [[{ inner: { id: 1 } }], [{ inner: {} }]]],
    ['nested array', { type: 'object', required: ['children'], properties: { children: { type: 'array', items: { $ref: '#/components/schemas/Item' }, minItems: 1 } } }, [{ children: [{ id: 3 }] }], [[{ children: [{ id: 1 }] }], [{ children: [] }]]],
    ['nullable object', { type: 'object', nullable: true, properties: { id: { type: 'integer', minimum: 2 } }, required: ['id'] }, [null, { id: 3 }], [[{ id: 1 }], [{}]]],
    ['default format', { type: 'object', default: { id: 3 }, properties: { id: { type: 'integer', minimum: 2, format: 'int32' } }, required: ['id'] }, [{ id: 3 }], [[{ id: 1 }], [{}]]],
    ['additional properties', { type: 'object', additionalProperties: { type: 'integer', minimum: 2 } }, [{ id: 3 }], [[{ id: 1 }]]],
    ['anyOf', { type: 'object', required: ['value'], properties: { value: { anyOf: [{ $ref: '#/components/schemas/Item' }, { type: 'string', const: 'safe' }] } } }, [{ value: 'safe' }, { value: { id: 3 } }], [[{ value: { id: 1 } }], [{ value: 'unsafe' }]]],
    ['oneOf', { type: 'object', required: ['value'], properties: { value: { oneOf: [{ $ref: '#/components/schemas/Item' }, { type: 'string', const: 'safe' }] } } }, [{ value: 'safe' }, { value: { id: 3 } }], [[{ value: { id: 1 } }], [{ value: 'unsafe' }]]],
   ] as const) {
    test(`${version} ${contentType} required=${required} flattened body array ${label}`, async () => {
      const doc = { openapi: version, info: { title: 'Array items', version: '1' }, components: { schemas: { Item: { type: 'object', properties: { id: { type: 'integer', minimum: 2 } }, required: ['id'] } } }, paths: {
        '/': { post: { operationId: 'post', requestBody: { required, content: { [contentType]: { schema: { type: 'object', required: ['tags'], properties: { tags: { type: 'array', items } } } } } }, responses: { '200': { description: 'ok' } } } },
      } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const tool = buildManifest(doc).tools[0]!;
      assert.ok(tool.args.some(arg => arg.name === 'tags' && arg.apiFieldPath?.join('.') === 'tags'));
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
      // Independent compilation of the original body schema, not the generated manifest.
      const original = oracle.compile({ type: 'object', required: ['tags'], properties: { tags: { type: 'array', items } },
        components: { schemas: doc.components!.schemas } });
      assert.equal(original({ tags: good }), true);
      assert.equal(validate({ tags: good }), true);
      for (const value of bad) {
        assert.equal(original({ tags: value }), false);
        assert.equal(validate({ tags: value }), false);
      }
      assert.equal(validate({}), !required);
    });
   }
  }
 }
}

for (const version of ['3.0.3', '3.1.0']) {
 test(`${version} flattened array retains default format and outer/item nullable views`, async () => {
  const doc = { openapi: version, info: { title: 'Compatibility', version: '1' }, components: { schemas: {} }, paths: {
    '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['tags'], properties: { tags: { type: 'array', nullable: true, default: [{ id: 3 }], items: {
        type: 'object', nullable: true, default: { id: 3 }, required: ['id'], properties: { id: { type: 'integer', minimum: 2, format: 'int32' } },
      } } },
    } } } }, responses: { '200': { description: 'ok' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  const branches = tool.args[0]!.schema.anyOf as Record<string, unknown>[];
  // Forge never carried object-array defaults; leave that outer view unchanged.
  assert.equal(branches[0]!.default, undefined);
  assert.deepEqual((branches[0]!.items as Record<string, unknown>).default, { id: 3 });
  assert.deepEqual((branches[0]!.items as Record<string, unknown>).type, ['object', 'null']);
  assert.equal(((branches[0]!.items as any).properties.id).format, 'int32');
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  assert.equal(validate({ tags: null }), true);
  assert.equal(validate({ tags: [null, { id: 3 }] }), true);
  assert.equal(validate({ tags: [{ id: 1 }] }), false);
  assert.equal(validate({}), false);
 });
}

for (const version of ['3.0.3', '3.1.0']) {
 for (const [label, item] of [
  ['oversized', { type: 'object', not: { const: 'x'.repeat(300000) } }],
  ['missing ref', { type: 'object', not: { $ref: '#/components/schemas/Missing' } }],
  ['cycle', { type: 'object', not: { $ref: '#/components/schemas/Loop' } }],
 ] as const) {
  test(`${version} body array item ${label} fallback does not reverse negation`, async () => {
   const doc = { openapi: version, info: { title: 'Item fallback', version: '1' }, components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } }, paths: {
    '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tags'], properties: { tags: { type: 'array', items: item } } } } } }, responses: { '200': { description: 'ok' } } } },
   } } as unknown as OpenAPIV3.Document;
   await init(doc);
   const manifest = buildManifest(doc);
   const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
   assert.equal(validate({ tags: [{ id: 3 }] }), true);
   assert.ok(manifest.warnings?.some(warning => warning.includes('item constraints omitted')));
  });
 }
}
