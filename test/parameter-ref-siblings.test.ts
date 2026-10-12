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
    test(`${version} ${location} parameter applies ref siblings only in 3.1`, async () => {
      const doc = { openapi: version, info: { title: 'Ref siblings', version: '1' }, components: { schemas: {
        Score: { type: 'integer', minimum: 0 },
      } }, paths: { [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true,
        schema: { $ref: '#/components/schemas/Score', maximum: 5 },
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
  test(`3.1 ${location} array items retain ref siblings`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Item ref siblings', version: '1' }, components: { schemas: { Score: { type: 'integer', minimum: 0 } } }, paths: {
      [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true, schema: {
        type: 'array', items: { $ref: '#/components/schemas/Score', maximum: 5 },
      } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
    assert.equal(validate({ v: [3] }), true);
    assert.equal(validate({ v: [9] }), false);
  });
}

for (const [label, sibling, schemas, good, bad] of [
  ['enum intersection', { enum: [2, 3] }, { Score: { type: 'integer', enum: [1, 2] } }, 2, [1, 3]],
  ['nested reference negation', { not: { $ref: '#/components/schemas/Excluded' } }, { Score: { type: 'integer' }, Excluded: { const: 3 } }, 2, [3]],
] as const) {
  test(`3.1 root ref siblings retain ${label}`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Sibling intersections', version: '1' }, components: { schemas }, paths: {
      '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: 'query', schema: { $ref: '#/components/schemas/Score', ...sibling } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
    assert.equal(validate({ v: good }), true);
    for (const value of bad) assert.equal(validate({ v: value }), false);
  });
}

for (const [label, sibling, schemas] of [
  ['oversized positive literal', { const: 'x'.repeat(300000) }, {}],
  ['oversized negated literal', { not: { const: 'x'.repeat(300000) } }, {}],
  ['unresolved negation', { not: { $ref: '#/components/schemas/Missing' } }, {}],
  ['cyclic negation', { not: { $ref: '#/components/schemas/Loop' } }, { Loop: { $ref: '#/components/schemas/Loop' } }],
] as const) {
  test(`3.1 ref sibling fallback preserves acceptance for ${label}`, async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Sibling fallback', version: '1' }, components: { schemas: { Score: { type: 'integer', minimum: 0 }, ...schemas } }, paths: {
      '/x': { get: { operationId: 'get', parameters: [{ name: 'v', in: 'query', schema: { $ref: '#/components/schemas/Score', ...sibling } }], responses: { '200': { description: 'ok' } } } },
    } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const manifest = buildManifest(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
    assert.equal(validate({ v: 3 }), true);
    assert.equal(validate({ v: -1 }), false);
    assert.ok(manifest.warnings?.some(warning => warning.includes('reference sibling constraints omitted')));
  });
}

for (const location of ['path', 'query', 'header', 'cookie']) {
for (const hops of [2, 3]) {
  for (const items of [false, true]) {
    test(`3.1 ${location} ${items ? 'item' : 'root'} reference preserves siblings across ${hops} hops`, async () => {
      const schemas = { Score: { type: 'integer', minimum: 0 }, Middle: { $ref: '#/components/schemas/Score', maximum: 5 }, Outer: { $ref: '#/components/schemas/Middle', minimum: 2 } };
      const ref = { $ref: `#/components/schemas/${hops === 2 ? 'Middle' : 'Outer'}` };
      const doc = { openapi: '3.1.0', info: { title: 'Chains', version: '1' }, components: { schemas }, paths: {
        [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true, schema: items ? { type: 'array', items: ref } : ref }], responses: { '200': { description: 'ok' } } } },
      } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
      assert.equal(validate({ v: items ? [3] : 3 }), true);
      assert.equal(validate({ v: items ? [9] : 9 }), false);
      if (hops === 3) assert.equal(validate({ v: items ? [1] : 1 }), false);
    });
  }
}

}
for (const location of ['path', 'query', 'header', 'cookie']) {
for (const keyword of ['not', 'anyOf', 'oneOf']) {
  test(`3.1 ${location} sibling ${keyword} keeps intermediate reference constraints`, async () => {
    const branch = { $ref: '#/components/schemas/Middle' };
    const sibling = keyword === 'not' ? { not: branch } : { [keyword]: [branch, { const: 10 }] };
    const doc = { openapi: '3.1.0', info: { title: 'Nested chains', version: '1' }, components: { schemas: {
      Score: { type: 'integer' }, Middle: { $ref: '#/components/schemas/Score', maximum: 5 },
    } }, paths: { [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true, schema: { $ref: '#/components/schemas/Score', ...sibling } }], responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
    await init(doc);
    const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
    assert.equal(validate({ v: 9 }), keyword === 'not');
    assert.equal(validate({ v: 3 }), keyword !== 'not');
    if (keyword !== 'not') assert.equal(validate({ v: 10 }), true);
  });
}

}
for (const location of ['path', 'query', 'header', 'cookie']) {
  for (const [label, type, rootEnum, siblingEnum, good, bad] of [
    ['integer enum', 'integer', undefined, [3], 3, [2, '3']],
    ['boolean enum', 'boolean', undefined, [true], true, [false, 'true']],
    ['integer enum intersection', 'integer', [2, 3], [3, 4], 3, [2, 4, '3']],
    ['boolean enum intersection', 'boolean', [true, false], [true], true, [false, 'true']],
    ['disjoint integer enum', 'integer', [2], [3], undefined, [2, 3, '3']],
    ['disjoint boolean enum', 'boolean', [false], [true], undefined, [true, false, 'true']],
  ] as const) {
    test(`3.1 ${location} reference siblings validate ${label}`, async () => {
      const doc = { openapi: '3.1.0', info: { title: 'Enum types', version: '1' }, components: { schemas: {
        Score: { type, ...(rootEnum ? { enum: rootEnum } : {}) },
      } }, paths: { [location === 'path' ? '/x/{v}' : '/x']: { get: { operationId: 'get', parameters: [{ name: 'v', in: location, required: true,
        schema: { $ref: '#/components/schemas/Score', enum: siblingEnum },
      }], responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
      await init(doc);
      const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
      if (good !== undefined) assert.equal(validate({ v: good }), true);
      for (const value of bad) assert.equal(validate({ v: value }), false);
    });
  }
}
