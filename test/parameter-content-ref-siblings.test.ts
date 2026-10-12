import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};

for (const version of ['3.1.0', '3.0.3']) {
  for (const location of ['path', 'query', 'header', 'cookie']) {
    test(`${version} ${location} content parameter applies ref siblings only in 3.1`, async () => {
      const doc = { openapi: version, info: { title: 'Ref siblings', version: '1' }, components: { schemas: {
        Score: { type: 'integer', minimum: 0 },
      } }, paths: { [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Score', maximum: 5 } } },
      }], responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
      assert.equal(validate({ v: 3 }), true);
      assert.equal(validate({ v: -1 }), false);
      assert.equal(validate({ v: 9 }), version === '3.0.3');
    });
  }
}

for (const location of ['path', 'query', 'header', 'cookie']) {
  for (const [label, schema, good, bad] of [
    ['two-hop', { $ref: '#/components/schemas/Middle' }, 3, [9]],
    ['three-hop', { $ref: '#/components/schemas/Outer' }, 3, [1, 9]],
    ['item ref', { type: 'array', items: { $ref: '#/components/schemas/Score', maximum: 5 } }, [3], [[9]]],
    ['item chain', { type: 'array', items: { $ref: '#/components/schemas/Outer' } }, [3], [[1], [9]]],
    ['negated chain', { $ref: '#/components/schemas/Score', not: { $ref: '#/components/schemas/Middle' } }, 9, [3]],
    ['anyOf chain', { $ref: '#/components/schemas/Score', anyOf: [{ $ref: '#/components/schemas/Middle' }, { const: 10 }] }, 3, [9]],
    ['oneOf chain', { $ref: '#/components/schemas/Score', oneOf: [{ $ref: '#/components/schemas/Middle' }, { const: 10 }] }, 10, [9]],
    ['integer enum', { $ref: '#/components/schemas/Score', enum: [3] }, 3, [2, '3']],
    ['boolean enum', { $ref: '#/components/schemas/Flag', enum: [true] }, true, [false, 'true']],
    ['enum intersection', { $ref: '#/components/schemas/Enum', enum: [3, 4] }, 3, [2, 4]],
    ['disjoint enums', { $ref: '#/components/schemas/Enum', enum: [4] }, undefined, [2, 3, 4]],
    ['nested object ref', { type: 'object', properties: { score: { $ref: '#/components/schemas/Outer' } }, required: ['score'] }, { score: 3 }, [{ score: 9 }]],
  ] as const) {
    test(`3.1 ${location} JSON content schema retains ${label}`, async () => {
      const doc = { openapi: '3.1.0', info: { title: 'Content sweep', version: '1' }, components: { schemas: {
        Score: { type: 'integer', minimum: 0 }, Middle: { $ref: '#/components/schemas/Score', maximum: 5 }, Outer: { $ref: '#/components/schemas/Middle', minimum: 2 },
        Flag: { type: 'boolean' }, Enum: { type: 'integer', enum: [2, 3] },
      } }, paths: { [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true,
        content: { 'application/json': { schema } },
      }], responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
      if (good !== undefined) assert.equal(validate({ v: good }), true);
      for (const value of bad) assert.equal(validate({ v: value }), false);
    });
  }
}

for (const location of ['path', 'query', 'header', 'cookie']) {
  for (const [label, schema] of [
    ['oversized', { not: { const: 'x'.repeat(300000) } }],
    ['missing ref', { not: { $ref: '#/components/schemas/Missing' } }],
    ['cyclic ref', { not: { $ref: '#/components/schemas/Loop' } }],
    ['deep schema', { not: (() => { let node: unknown = { const: 3 }; for (let i = 0; i < 20; i++) node = { allOf: [node] }; return node; })() }],
  ] as const) {
    test(`3.1 ${location} content mapping warns and widens ${label} without flipping polarity`, async () => {
      const doc = { openapi: '3.1.0', info: { title: 'Content fallback', version: '1' }, components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } }, paths: {
        [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true, content: { 'application/json': { schema } } }], responses: { '200': { description: 'ok' } } } },
      } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const manifest = buildManifest(doc);
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
      assert.equal(validate({ v: 3 }), true);
      assert.equal(validate({ v: 'ok' }), true);
      assert.deepEqual(manifest.tools[0]!.args[0]!.schema, {});
      assert.ok(manifest.warnings?.some(warning => warning.includes('content schema constraints omitted')));
    });
  }
}
