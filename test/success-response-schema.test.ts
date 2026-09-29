import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

const response = (label: string) => ({ description: label, content: {
  'application/json': { schema: { type: 'object', properties: { [label]: { type: 'string' } } } },
} });

test('2XX ranges and default fallback expose JSON output schemas', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Responses', version: '1' },
    components: { schemas: {} }, paths: {
      '/range': { get: { operationId: 'range', responses: { '2XX': response('range') } } },
      '/fallback': { get: { operationId: 'fallback', responses: { default: response('fallback') } } },
      '/priority': { get: { operationId: 'priority', responses: {
        default: response('fallback'), '2XX': response('range'), '201': response('specific'),
      } } },
      '/range-priority': { get: { operationId: 'rangePriority', responses: {
        default: response('fallback'), '2XX': response('range'),
      } } },
    },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const tools = buildManifest(doc).tools;
  const properties = (name: string) => tools.find((t) => t.name === name)?.outputSchema?.properties;
  assert.deepEqual(Object.keys(properties('range') ?? {}), ['range']);
  assert.deepEqual(Object.keys(properties('fallback') ?? {}), ['fallback']);
  assert.deepEqual(Object.keys(properties('priority') ?? {}), ['specific']);
  assert.deepEqual(Object.keys(properties('range_priority') ?? {}), ['range']);
});
