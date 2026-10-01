import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

test('scalar cookie primitive compositions keep branch types and sibling constraints', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Cookie choice', version: '1' }, components: { schemas: {} },
    paths: { '/': { get: { operationId: 'get', parameters: [{ name: 'choice', in: 'cookie', schema: {
      anyOf: [{ type: 'integer', minimum: 1, maximum: 5 }, { type: 'string', pattern: '^safe$' }],
    } }, { name: 'locked', in: 'cookie', schema: { oneOf: [{ type: 'integer' }, { type: 'string' }], const: 'safe' } }, { name: 'limited', in: 'cookie', schema: { oneOf: [{ type: 'integer' }, { type: 'string' }], enum: ['a', 1], default: 'a' } }], responses: { '200': { description: 'ok' } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.equal(tool.args.find(arg => arg.name === 'limited')?.schema.default, 'a');
  const validate = compileOutputValidator(tool.inputSchema);
  for (const choice of [3, 'safe']) assert.equal(validate({ choice, locked: 'safe' }), true);
  for (const choice of [1.5, 999, 'unsafe', true, null]) assert.equal(validate({ choice }), false, JSON.stringify(choice));
  for (const limited of ['a', 1]) assert.equal(validate({ limited }), true);
  for (const limited of ['outside', 2]) assert.equal(validate({ limited }), false);
  for (const locked of [3, 'unsafe']) assert.equal(validate({ locked }), false, JSON.stringify(locked));
});
