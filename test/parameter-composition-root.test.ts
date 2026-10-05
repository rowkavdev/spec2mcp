import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

for (const location of ['path', 'query', 'header', 'cookie']) {
  test(`primitive ${location} compositions retain sibling type and enum constraints`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Compositions', version: '1' }, components: { schemas: {} },
      paths: { [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'x', parameters: [{ name: 'v', in: location, required: true, schema: {
        type: 'integer', enum: [2, 'safe'], anyOf: [{ type: 'integer' }, { type: 'string' }],
      } }], responses: { '200': { description: 'OK' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const tool = buildManifest(doc).tools[0]!;
    const arg = tool.args.find(a => a.location === location)!;
    assert.equal(arg.schema.type, 'integer');
    assert.deepEqual(arg.schema.enum, [2, 'safe']);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
    const args = { v: 2 };
    assert.equal(validate(args), true);
    assert.equal(validate({ ...args, [arg.name]: 3 }), false);
    assert.equal(validate({ ...args, [arg.name]: 'safe' }), false);
  });
}

for (const location of ['path', 'query', 'header', 'cookie']) {
  test(`primitive ${location} parameters retain simultaneous anyOf and oneOf`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Intersections', version: '1' }, components: { schemas: {} },
      paths: { [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'x', parameters: [{ name: 'v', in: location, required: true, schema: {
        anyOf: [{ type: 'integer', minimum: 5 }], oneOf: [{ type: 'integer' }, { type: 'string' }],
      } }], responses: { '200': { description: 'OK' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const tool = buildManifest(doc).tools[0]!;
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
    assert.equal(validate({ v: 5 }), true);
    assert.equal(validate({ v: 4 }), false);
    assert.equal(validate({ v: 'safe' }), false);
  });
}

for (const location of ['path', 'query', 'header', 'cookie']) {
  test(`primitive ${location} parameters retain allOf constraints alongside anyOf`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'AllOf intersection', version: '1' }, components: { schemas: {} },
      paths: { [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'x', parameters: [{ name: 'v', in: location, required: true, schema: {
        allOf: [{ type: 'integer', minimum: 5 }], anyOf: [{ type: 'integer' }, { type: 'string' }],
      } }], responses: { '200': { description: 'OK' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    const tool = buildManifest(doc).tools[0]!;
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
    assert.equal(validate({ v: 5 }), true);
    assert.equal(validate({ v: 4 }), false);
    assert.equal(validate({ v: 'safe' }), false);
  });
}

for (const [label, source, expected] of [
  ['allOf-only enum default', { allOf: [{ $ref: '#/components/schemas/Enum' }], default: 'safe' }, { type: 'string', enum: ['safe'], default: 'safe' }],
  ['allOf-only nullable', { nullable: true, allOf: [{ type: 'string' }] }, { type: ['string', 'null'] }],
] as const) {
  test(`query parameter preserves the existing flat view for ${label}`, async () => {
    const doc = { openapi: '3.0.3', info: { title: 'Old allOf', version: '1' }, components: { schemas: { Enum: { type: 'string', enum: ['safe'] } } },
      paths: { '/x': { get: { operationId: 'x', parameters: [{ name: 'v', in: 'query', schema: source }], responses: { '200': { description: 'OK' } } } } },
    } as unknown as OpenAPIV3.Document;
    await init(doc);
    assert.deepEqual(buildManifest(doc).tools[0]!.args[0]!.schema, expected);
  });
}

test('composed query parameter retains default and nullable without branch format', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Composed nullable', version: '1' }, components: { schemas: {} }, paths: {
    '/x': { get: { operationId: 'x', parameters: [{ name: 'v', in: 'query', schema: {
      nullable: true, default: 'safe', allOf: [{ type: 'string', format: 'custom' }], anyOf: [{ type: 'string', pattern: '^safe$' }],
    } }], responses: { '200': { description: 'OK' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.equal(tool.args[0]!.schema.default, 'safe');
  assert.ok(!JSON.stringify(tool.args[0]!.schema).includes('format'));
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  assert.equal(validate({ v: null }), true);
  assert.equal(validate({ v: 'safe' }), true);
  assert.equal(validate({ v: 'unsafe' }), false);
});

for (const keyword of ['anyOf', 'oneOf']) {
  test(`${keyword}-only primitive branches retain their existing format annotation`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Branch formats', version: '1' }, components: { schemas: {} }, paths: {
      '/x': { get: { operationId: 'x', parameters: [{ name: 'v', in: 'query', schema: {
        [keyword]: [{ type: 'string', format: 'uuid' }, { type: 'integer' }],
      } }], responses: { '200': { description: 'OK' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const schema = buildManifest(doc).tools[0]!.args[0]!.schema;
    assert.equal((schema[keyword] as Record<string, unknown>[])[0]!.format, 'uuid');
  });
}
