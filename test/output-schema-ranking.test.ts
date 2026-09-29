/**
 * #60/#61: success response schema selection across statuses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

function doc(paths: Record<string, unknown>, schemas: Record<string, unknown> = {}): OpenAPIV3.Document {
  return {
    openapi: '3.0.3',
    info: { title: 'Ranking API', version: '1.0.0' },
    servers: [{ url: 'http://placeholder.invalid' }],
    paths,
    components: { schemas },
  } as unknown as OpenAPIV3.Document;
}

// One oversized schema - a single huge description blows the deref budget
// at depth 0 (deep $ref chains do not: MAX_SCHEMA_DEPTH caps them cheaply).
const chainSchemas: Record<string, unknown> = {
  Huge: { type: 'object', description: 'x'.repeat(5000), properties: { id: { type: 'string' } } },
};

test('#60 an over-budget first-ranked schema falls through to the next 2xx', async () => {
  const d = doc({
    '/things': {
      post: {
        operationId: 'makeThing',
        responses: {
          '200': {
            description: 'huge',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Huge' } } },
          },
          '201': {
            description: 'small',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
        },
      },
    },
  }, chainSchemas);
  await init(d);
  const m = buildManifest(d);
  const tool = m.tools.find((t) => t.name === 'make_thing');
  // #61 supersedes the ranked fallback here: the 200 shape is unknown
  // (over budget), so shape equality across success statuses cannot be
  // proven and nothing is advertised - a valid 200 must never be rejected
  // against a schema it was not validated with.
  assert.equal(tool?.outputSchema, undefined, 'unknown-shape status forces text-only');
});

test('#61 same shape across 200 and 201 is advertised', async () => {
  const shape = { type: 'object', properties: { id: { type: 'string' } } };
  const d = doc({
    '/things': {
      post: {
        operationId: 'makeThing',
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: shape } } },
          '201': { description: 'created', content: { 'application/json': { schema: shape } } },
          '204': { description: 'no body' },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  assert.equal(m.tools[0]?.outputSchema?.type, 'object', 'one shared shape, bodiless statuses skipped');
});

test('#61 differing success shapes advertise no outputSchema', async () => {
  const d = doc({
    '/things': {
      post: {
        operationId: 'makeThing',
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } },
          '201': { description: 'created', content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' } } } } } },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  assert.equal(m.tools[0]?.outputSchema, undefined, 'a valid 201 must never be validated against the 200 shape');
});
