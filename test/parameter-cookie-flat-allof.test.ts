import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  compileOutputValidator: (schema: unknown) => (value: unknown) => boolean;
};
for (const version of ['3.0.3', '3.1.0']) {
  for (const [label, schema, good, bad] of [
    ['root bounds', { type: 'integer', allOf: [{ minimum: 2 }, { maximum: 5 }] }, 3, [1, 6, 2.5]],
    ['integer items', { type: 'array', items: { allOf: [{ type: 'integer', minimum: 2, maximum: 5 }] } }, [3], [[1], [6], [2.5]]],
  ] as const) {
    test(`${version} cookie allOf-only ${label} validates`, async () => {
      const doc = { openapi: version, info: { title: 'Cookie allOf', version: '1' }, components: { schemas: {} }, paths: {
        '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: 'cookie', schema }], responses: { '200': { description: 'ok' } } } },
      } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
      assert.equal(validate({ v: good }), true);
      for (const value of bad) assert.equal(validate({ v: value }), false);
    });
  }
}

for (const version of ['3.0.3', '3.1.0']) {
  for (const [location, styles] of [
    ['path', ['simple', 'label', 'matrix']], ['query', ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject']],
    ['header', ['simple']], ['cookie', ['form']],
  ] as const) {
    for (const style of styles) {
      for (const explode of [false, true]) {
        for (const [label, schema, good, bad] of [
          ['root range', { type: 'integer', allOf: [{ minimum: 2 }, { maximum: 5 }] }, 3, [1, 6, 2.5]],
          ['integer recovery', { allOf: [{ type: 'integer', minimum: 2, maximum: 5 }] }, 3, [1, 6, 2.5]],
          ['string pattern length', { allOf: [{ type: 'string', pattern: '^s', minLength: 4, maxLength: 4 }] }, 'safe', ['wee', 's', 'safee']],
          ['patterns intersect', { allOf: [{ type: 'string', pattern: '^s' }, { type: 'string', pattern: 'e$' }] }, 'safe', ['sail', 'wee']],
          ['numeric intersection', { allOf: [{ type: 'number', minimum: 2 }, { type: 'integer', maximum: 5 }] }, 3, [1, 6, 2.5]],
          ['root enum intersection', { type: 'integer', enum: [2, 3], allOf: [{ type: 'integer', enum: [3, 4] }] }, 3, [2, 4]],
          ['integer items', { type: 'array', items: { allOf: [{ type: 'integer', minimum: 2, maximum: 5 }] } }, [3], [[1], [6], [2.5]]],
          ['string items', { type: 'array', items: { allOf: [{ type: 'string', pattern: '^safe$', minLength: 4 }] } }, ['safe'], [['s'], ['unsafe']]],
        ] as const) {
          test(`${version} ${location} ${style} explode=${explode} flat allOf ${label}`, async () => {
            const doc = { openapi: version, info: { title: 'Flat sweep', version: '1' }, components: { schemas: {} }, paths: {
              [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true, style, explode, schema }], responses: { '200': { description: 'ok' } } } },
            } } as unknown as OpenAPIV3.Document;
            await init(doc);
            const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
            assert.equal(validate({ v: good }), true);
            for (const value of bad) assert.equal(validate({ v: value }), false);
          });
        }
      }
    }
  }
}

for (const version of ['3.0.3', '3.1.0']) {
  test(`${version} cookie flat allOf preserves default nullable and excludes branch format`, async () => {
    const doc = { openapi: version, info: { title: 'Flat compatibility', version: '1' }, components: { schemas: {} }, paths: {
      '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: 'cookie', schema: { nullable: true, default: 3, allOf: [{ type: 'integer', minimum: 2, format: 'int32' }] } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const tool = buildManifest(doc).tools[0]!;
    assert.deepEqual(tool.args[0]!.schema, { anyOf: [{ type: 'integer', default: 3, minimum: 2 }, { type: 'null' }] });
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
    assert.equal(validate({ v: null }), true);
    assert.equal(validate({ v: 3 }), true);
    assert.equal(validate({ v: 1 }), false);
  });
}
