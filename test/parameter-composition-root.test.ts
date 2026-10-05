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
