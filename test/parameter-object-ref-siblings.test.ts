import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};
for (const location of ['query', 'header', 'cookie']) {
  test(`3.1 ${location} object property retains ref siblings`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Object siblings', version: '1' }, components: { schemas: { Score: { type: 'integer', minimum: 0 } } }, paths: {
      '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: location, schema: { type: 'object', required: ['score'], properties: { score: { $ref: '#/components/schemas/Score', maximum: 5 } } } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
    assert.equal(validate({ v: { score: 3 } }), true);
    assert.equal(validate({ v: { score: 9 } }), false);
  });
}

const cases = [
  ['chain', { $ref: '#/components/schemas/Outer' }, 3, [1, 9]],
  ['negated chain', { $ref: '#/components/schemas/Score', not: { $ref: '#/components/schemas/Middle' } }, 9, [3]],
  ['anyOf chain', { $ref: '#/components/schemas/Score', anyOf: [{ $ref: '#/components/schemas/Middle' }, { const: 10 }] }, 10, [9]],
  ['oneOf chain', { $ref: '#/components/schemas/Score', oneOf: [{ $ref: '#/components/schemas/Middle' }, { const: 10 }] }, 3, [9]],
  ['integer enum', { $ref: '#/components/schemas/Score', enum: [3] }, 3, [2, '3']],
  ['boolean enum', { $ref: '#/components/schemas/Flag', enum: [true] }, true, [false, 'true']],
  ['enum intersection', { $ref: '#/components/schemas/Enum', enum: [3, 4] }, 3, [2, 4]],
  ['disjoint enum', { $ref: '#/components/schemas/Enum', enum: [4] }, undefined, [2, 3, 4]],
] as const;
for (const location of ['query', 'header', 'cookie']) {
  for (const style of ['form', 'deepObject']) {
    for (const shape of ['required', 'optional', 'additionalProperties', 'array', 'nested']) {
      for (const [label, leaf, good, bad] of cases) {
        test(`3.1 ${location} ${style} ${shape} keeps ${label}`, async () => {
          const object = { type: 'object', properties: { score: leaf }, ...(shape === 'optional' ? {} : { required: ['score'] }) };
          const schema = shape === 'additionalProperties' ? { type: 'object', additionalProperties: leaf }
            : shape === 'array' ? { type: 'array', items: object }
            : shape === 'nested' ? { type: 'object', properties: { outer: { type: 'object', required: ['inner'], properties: { inner: object } } }, required: ['outer'] }
            : object;
          const wrap = (value: unknown) => shape === 'array' ? [{ score: value }] : shape === 'nested' ? { outer: { inner: { score: value } } } : { score: value };
          const doc = { openapi: '3.1.0', info: { title: 'Object sweep', version: '1' }, components: { schemas: {
            Score: { type: 'integer', minimum: 0 }, Middle: { $ref: '#/components/schemas/Score', maximum: 5 }, Outer: { $ref: '#/components/schemas/Middle', minimum: 2 },
            Flag: { type: 'boolean' }, Enum: { type: 'integer', enum: [2, 3] },
          } }, paths: { '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: location, style, schema }], responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
          await init(doc);
          const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
          if (good !== undefined) assert.equal(validate({ v: wrap(good) }), true);
          for (const value of bad) assert.equal(validate({ v: wrap(value) }), false);
          if (shape === 'optional') assert.equal(validate({ v: {} }), true);
          if (shape === 'required') assert.equal(validate({ v: {} }), false);
        });
      }
    }
  }
}

for (const location of ['query', 'header', 'cookie']) {
  for (const [label, leaf] of [
    ['oversized negation', { not: { const: 'x'.repeat(300000) } }],
    ['missing negation', { not: { $ref: '#/components/schemas/Missing' } }],
    ['cyclic negation', { not: { $ref: '#/components/schemas/Loop' } }],
    ['depth overflow', { not: (() => { let node: unknown = { const: 3 }; for (let i = 0; i < 20; i++) node = { allOf: [node] }; return node; })() }],
  ] as const) {
    test(`3.1 ${location} object mapping widens with warning for ${label}`, async () => {
      const doc = { openapi: '3.1.0', info: { title: 'Object fallback', version: '1' }, components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } }, paths: {
        '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: location, schema: { type: 'object', properties: { score: leaf } } }], responses: { '200': { description: 'ok' } } } },
      } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const manifest = buildManifest(doc);
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
      assert.equal(validate({ v: { score: 3 } }), true);
      assert.equal(validate({ v: { score: 'ok' } }), true);
      assert.ok(manifest.warnings?.some(warning => warning.includes('object schema constraints omitted')));
    });
  }
}

for (const style of ['simple', 'label', 'matrix']) {
  test(`3.1 path ${style} array of objects keeps the existing adapted view`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Path scope', version: '1' }, components: { schemas: { S: { type: 'integer' } } }, paths: {
      '/x/{v}': { get: { operationId: 'get', parameters: [{ name: 'v', in: 'path', required: true, style, schema: {
        type: 'array', items: { type: 'object', properties: { p: { $ref: '#/components/schemas/S', maximum: 3 } }, required: ['p'] },
      } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    assert.deepEqual(buildManifest(doc).tools[0]!.args[0]!.schema, { type: 'array', items: { type: 'object' } });
  });
}
