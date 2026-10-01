import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

async function firstTool(doc: unknown) {
  const spec = doc as OpenAPIV3.Document;
  await init(spec);
  const tool = buildManifest(spec).tools[0];
  assert.ok(tool, 'the spec produced no tools');
  return tool;
}

// Each test below builds a manifest from a small spec and checks the tool arguments.

test('an operation parameter overrides a path-level parameter with the same name and location', async () => {
  const tool = await firstTool({
    openapi: '3.0.3', info: { title: 'Override', version: '1' }, components: { schemas: {} },
    paths: { '/a/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
      ],
      get: { operationId: 'getA', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } },
    } },
  });
  const q = tool.args.filter((arg) => arg.name === 'q');
  assert.equal(q.length, 1);
  const [only] = q;
  assert.ok(only);
  assert.deepEqual(only.schema, { type: 'integer' });
  assert.equal(only.required, true);
  assert.ok(tool.args.some((arg) => arg.name === 'id' && arg.location === 'path'));
});

test('a $ref to components.parameters keeps its schema constraints and optionality', async () => {
  const tool = await firstTool({
    openapi: '3.0.3', info: { title: 'ParamRef', version: '1' },
    components: { schemas: {}, parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 5 } } } },
    paths: { '/items': { get: { operationId: 'listItems', parameters: [{ $ref: '#/components/parameters/Limit' }], responses: { '200': { description: 'OK' } } } } },
  });
  const limit = tool.args.find((arg) => arg.name === 'limit');
  assert.ok(limit);
  assert.equal(limit.location, 'query');
  assert.equal(limit.required, false);
  assert.deepEqual(limit.schema, { type: 'integer', maximum: 5 });
});

test('a $ref to components.requestBodies exposes its fields as body arguments', async () => {
  const tool = await firstTool({
    openapi: '3.0.3', info: { title: 'BodyRef', version: '1' },
    components: { schemas: {}, requestBodies: { Item: { required: true, content: { 'application/json': { schema: {
      type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } }, required: ['name'],
    } } } } } },
    paths: { '/items': { post: { operationId: 'createItem', requestBody: { $ref: '#/components/requestBodies/Item' }, responses: { '201': { description: 'Created' } } } } },
  });
  const body = tool.args.filter((arg) => arg.location === 'body');
  assert.deepEqual(body.map((arg) => arg.name).sort(), ['count', 'name']);
  assert.equal(body.find((arg) => arg.name === 'name')?.required, true);
  assert.equal(body.find((arg) => arg.name === 'count')?.required, false);
});
