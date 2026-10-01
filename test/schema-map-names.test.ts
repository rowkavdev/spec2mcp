import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

for (const mapKeyword of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
  test(`schema-looking names in ${mapKeyword} survive dereferencing`, async () => {
    const schemas = { xml: { type: 'string' }, nullable: { type: 'boolean' }, discriminator: { type: 'string' }, externalDocs: { type: 'string' }, $ref: { type: 'string' } };
    const doc = { openapi: '3.1.0', info: { title: 'Names', version: '1' }, components: { schemas: {
      Name: { type: 'string' },
    } }, paths: { '/value': { get: { operationId: 'getValue', parameters: [{ name: 'filter', in: 'query', content: { 'application/json': { schema: { type: 'object', [mapKeyword]: schemas } } } }], responses: {
      '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', [mapKeyword]: schemas } } } },
    } } } } };
    await init(doc as any);
    const tool = buildManifest(doc as any).tools[0]!;
    assert.deepEqual(tool.outputSchema?.[mapKeyword], schemas);
    assert.deepEqual(tool.args.find(a => a.name === 'filter')?.schema[mapKeyword], schemas);
  });
}

test('map values still resolve refs and remove actual OpenAPI annotations', async () => {
  const doc = { openapi: '3.1.0', info: { title: 'Names', version: '1' }, components: { schemas: {
    Name: { type: 'string', xml: { name: 'actual annotation' } },
  } }, paths: { '/value': { get: { operationId: 'getValue', responses: {
    '200': { description: 'ok', content: { 'application/json': { schema: {
      type: 'object', properties: { xml: { $ref: '#/components/schemas/Name' }, nullable: { type: 'string', nullable: true } },
    } } } },
  } } } } };
  await init(doc as any);
  assert.deepEqual(buildManifest(doc as any).tools[0]?.outputSchema?.properties, {
    xml: { type: 'string' }, nullable: { type: ['string', 'null'] },
  });
});
