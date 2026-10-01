import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

function document(schema: unknown, parameterSchema?: unknown): any {
  return { openapi: '3.1.0', info: { title: 'Literals', version: '1' }, components: { schemas: {
    NotData: { type: 'string' },
  } }, paths: { '/value': { get: { operationId: 'getValue',
    ...(parameterSchema ? { parameters: [{ name: 'filter', in: 'query', content: { 'application/json': { schema: parameterSchema } } }] } : {}),
    responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
  } } } };
}

for (const keyword of ['const', 'enum', 'default', 'example', 'examples']) {
  test(`dereferencing preserves schema-looking literal ${keyword} data`, async () => {
    const literal = { nullable: true, xml: { name: 'payload' }, $ref: '#/components/schemas/NotData', type: 'object', nested: { $ref: '#/missing' } };
    const value = keyword === 'enum' || keyword === 'examples' ? [literal] : literal;
    const property = { type: 'object', [keyword]: value };
    const doc = document({ type: 'object', properties: { value: property }, required: ['value'] }, property);
    await init(doc);
    const tool = buildManifest(doc).tools[0]!;
    assert.deepEqual((tool.outputSchema?.properties as any)?.value?.[keyword], value);
    assert.deepEqual(tool.args.find(a => a.name === 'filter')?.schema[keyword], value);
  });
}

test('actual schema references still resolve while literal refs remain data', async () => {
  const doc = document({ type: 'object', properties: { value: { $ref: '#/components/schemas/NotData' } } });
  await init(doc);
  assert.deepEqual((buildManifest(doc).tools[0]?.outputSchema?.properties as any)?.value, { type: 'string' });
});

test('large literal values still obey the output schema byte budget', async () => {
  const doc = document({ type: 'object', properties: { value: { const: 'x'.repeat(5000) } } });
  await init(doc);
  assert.equal(buildManifest(doc).tools[0]?.outputSchema, undefined);
});

test('deep literal values are not silently truncated to empty objects', async () => {
  let literal: unknown = 'leaf';
  for (let i = 0; i < 20; i++) literal = { value: literal };
  const doc = document({ type: 'object', properties: { value: { const: literal } } });
  await init(doc);
  assert.equal(buildManifest(doc).tools[0]?.outputSchema, undefined);
});

for (const map of ['properties', '$defs', 'patternProperties']) {
  test(`schema map ${map} treats literal keyword names as field names`, async () => {
    const fields = Object.fromEntries(['const', 'enum', 'default', 'xml', 'nullable'].map(name => [name, { $ref: '#/components/schemas/NotData' }]));
    const doc = document({ type: 'object', [map]: fields });
    await init(doc);
    const result = buildManifest(doc).tools[0]?.outputSchema?.[map] as Record<string, unknown>;
    for (const name of Object.keys(fields)) assert.deepEqual(result?.[name], { type: 'string' });
  });
}
