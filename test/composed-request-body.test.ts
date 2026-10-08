import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

for (const composition of ['oneOf', 'anyOf']) {
  test(`JSON ${composition} body retains branch discriminators and constraints`, async () => {
    const doc = {
      openapi: '3.0.3', info: { title: 'Composed body', version: '1' }, components: { schemas: {} },
      paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
        [composition]: [
          { type: 'object', required: ['kind', 'value'], properties: { kind: { const: 'integer' }, value: { type: 'integer', minimum: 1 } } },
          { type: 'object', required: ['kind', 'value'], properties: { kind: { const: 'text' }, value: { type: 'string', pattern: '^safe$' } } },
        ],
      } } } }, responses: { '200': { description: 'ok' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(buildManifest(doc).tools[0]!.inputSchema);
    for (const body of [{ kind: 'integer', value: 3 }, { kind: 'text', value: 'safe' }]) assert.equal(validate({ body }), true);
    for (const body of [{}, { kind: 'integer', value: 'safe' }, { kind: 'text', value: 'unsafe' }, { kind: 'integer', value: 0 }]) assert.equal(validate({ body }), false);
    assert.equal(validate({}), false, 'required body stays required');
  });
}

for (const explicit of [true, false]) {
  test(`discriminated oneOf refs validate the selected branch (${explicit ? 'mapped' : 'implicit'})`, async () => {
    const doc = {
      openapi: '3.0.3', info: { title: 'Pets', version: '1' }, components: { schemas: {
        Cat: { type: 'object', required: ['petType', 'meow'], properties: { petType: { type: 'string' }, meow: { type: 'boolean' } } },
        Dog: { type: 'object', required: ['petType'], properties: { petType: { type: 'string' }, bark: { type: 'boolean' } } },
      } },
      paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
        oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
        discriminator: { propertyName: 'petType', ...(explicit ? { mapping: { cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' } } : {}) },
      } } } }, responses: { '200': { description: 'ok' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(buildManifest(doc).tools[0]!.inputSchema);
    const cat = explicit ? 'cat' : 'Cat';
    const dog = explicit ? 'dog' : 'Dog';
    assert.equal(validate({ body: { petType: cat, meow: true } }), true);
    assert.equal(validate({ body: { petType: dog, bark: false } }), true);
    assert.equal(validate({ body: { petType: cat, meow: 'x' } }), false);
    assert.equal(validate({ body: { petType: 'unknown', meow: true } }), false);
  });
}

test('a discriminator named constructor does not inherit an object prototype property', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Prototype discriminator', version: '1' }, components: { schemas: {
    Cat: { type: 'object', properties: { meow: { type: 'boolean' } } },
    Dog: { type: 'object', properties: { bark: { type: 'boolean' } } },
  } }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
    oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
    discriminator: { propertyName: 'constructor' },
  } } } }, responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const schema = buildManifest(doc).tools[0]!.inputSchema;
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(schema)));
  assert.equal(validate({ body: { constructor: 'Cat', meow: true } }), true);
  assert.equal(validate({ body: { constructor: 'unknown' } }), false);
});

test('a discriminator named __proto__ does not inherit an object prototype property', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Prototype discriminator', version: '1' }, components: { schemas: {
    Cat: { type: 'object', properties: { meow: { type: 'boolean' } } },
    Dog: { type: 'object', properties: { bark: { type: 'boolean' } } },
  } }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
    oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
    discriminator: { propertyName: '__proto__' },
  } } } }, responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const schema = buildManifest(doc).tools[0]!.inputSchema;
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(schema)));
  assert.equal(validate({ body: JSON.parse('{"__proto__":"Cat","meow":true}') }), true);
  assert.equal(validate({ body: JSON.parse('{"__proto__":"unknown"}') }), false);
});

test('a required __proto__ discriminator rejects a missing own field', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Proto required', version: '1' }, components: { schemas: {
    Cat: { type: 'object', properties: { meow: { type: 'boolean' } }, additionalProperties: false },
    Dog: { type: 'object', properties: { bark: { type: 'boolean' } }, additionalProperties: false },
  } }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
    oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }], discriminator: { propertyName: '__proto__' },
  } } } }, responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
  assert.equal(validate({ body: { meow: true } }), false);
  assert.equal(validate({ body: JSON.parse('{"__proto__":"Cat","meow":true}') }), true);
});

test('an anyOf body with root required fields is not flattened past its branch constraints', async () => {
  const doc = { openapi: '3.1.0', info: { title: 'AnyOf with root fields', version: '1' }, components: { schemas: {} }, paths: {
    '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'],
      anyOf: [{ properties: { mode: { const: 'a' } } }, { properties: { mode: { const: 'b' } } }],
    } } } }, responses: { '200': { description: 'ok' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.deepEqual(tool.args.map(arg => arg.name), ['body']);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  assert.equal(validate({ body: { mode: 'a' } }), true);
  assert.equal(validate({ body: { mode: 'b' } }), true);
  assert.equal(validate({ body: { mode: 'wrong' } }), false);
  assert.equal(validate({ body: {} }), false);
});
