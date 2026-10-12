import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

for (const keyword of ['anyOf', 'oneOf']) {
for (const location of ['path', 'query', 'header', 'cookie']) {
  test(`primitive ${location} ${keyword} composition retains sibling not`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Negation', version: '1' }, components: { schemas: {} }, paths: {
      [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true, schema: {
        [keyword]: [{ type: 'integer' }, { type: 'string' }], not: { const: 3 },
      } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
    assert.equal(validate({ v: 2 }), true);
    assert.equal(validate({ v: 3 }), false);
  });
}
}

for (const location of ['path', 'query', 'header', 'cookie']) {
  for (const [label, not] of [
    ['reference', { $ref: '#/components/schemas/Excluded' }],
    ['nested reference', { anyOf: [{ $ref: '#/components/schemas/Excluded' }, { const: 4 }] }],
  ] as const) {
    test(`primitive ${location} composition resolves ${label} in not`, async () => {
      const doc = { openapi: '3.1.0', info: { title: 'Referenced negation', version: '1' }, components: { schemas: { Excluded: { const: 3 } } }, paths: {
        [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true, schema: {
          anyOf: [{ type: 'integer' }, { type: 'string' }], not,
        } }], responses: { '200': { description: 'ok' } } } },
      } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
      assert.equal(validate({ v: 2 }), true);
      assert.equal(validate({ v: 3 }), false);
      assert.equal(validate({ v: 4 }), label === 'reference');
    });
  }
}

test('nullable composition keeps null outside sibling negation', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Nullable negation', version: '1' }, components: { schemas: {} }, paths: {
    '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: 'query', schema: {
      nullable: true, anyOf: [{ type: 'integer' }, { type: 'string' }], not: { const: null },
    } }], responses: { '200': { description: 'ok' } } } },
  } } as unknown as OpenAPIV3.Document;
  await init(doc);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
  assert.equal(validate({ v: null }), true);
  assert.equal(validate({ v: 2 }), true);
});

for (const [label, not, schemas, bad] of [
  ['3.1 reference sibling', { $ref: '#/components/schemas/Excluded', const: 4 }, { Excluded: { type: 'integer' } }, 4],
  ['oversized literal', { const: 'x'.repeat(300000) }, {}, undefined],
  ['missing reference', { $ref: '#/components/schemas/Missing' }, {}, undefined],
  ['cyclic reference', { $ref: '#/components/schemas/Loop' }, { Loop: { $ref: '#/components/schemas/Loop' } }, undefined],
  ['depth limit', { allOf: Array.from({ length: 1 }, () => {
    let node: unknown = { const: 4 };
    for (let i = 0; i < 20; i++) node = { allOf: [node] };
    return node;
  }) }, {}, undefined],
] as const) {
  test(`primitive negation handles ${label} without rejecting valid values`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Negation mapping', version: '1' }, components: { schemas }, paths: {
      '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: 'query', schema: {
        anyOf: [{ type: 'integer' }, { type: 'string' }], not,
      } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const manifest = buildManifest(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
    assert.equal(validate({ v: 2 }), true);
    assert.equal(validate({ v: 3 }), true);
    assert.equal(validate({ v: 'ok' }), true);
    if (bad !== undefined) assert.equal(validate({ v: bad }), false);
    else {
      assert.ok(manifest.warnings?.some(warning => warning.includes('not') && warning.includes('omitted')));
      assert.equal(manifest.tools[0]!.args[0]!.schema.not, undefined);
    }
  });
}
