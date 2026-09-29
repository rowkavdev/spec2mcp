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
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  // #72: a bodiless success status alongside these would force text-only
  // (see the 204 case below); with every success carrying the same JSON
  // shape, advertising is honest.
  assert.equal(m.tools[0]?.outputSchema?.type, 'object', 'one shared shape across every success status');
});

test('#72 a bodyless success status forces text-only', async () => {
  const shape = { type: 'object', properties: { id: { type: 'string' } } };
  const d = doc({
    '/things': {
      post: {
        operationId: 'makeThing',
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: shape } } },
          '204': { description: 'no body' },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  // A valid 204 returns no structured content; advertising the 200 shape
  // would mark that empty success isError.
  assert.equal(m.tools[0]?.outputSchema, undefined, 'a valid empty 204 must not be validated against the 200 shape');
});

test('#72 a schema-less JSON success status forces text-only', async () => {
  const d = doc({
    '/things': {
      post: {
        operationId: 'makeThing',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
          '202': { description: 'accepted, shape unspecified', content: { 'application/json': {} } },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  // The 202 JSON alternative admits any shape; a valid 202 must not be
  // rejected against the 200 schema.
  assert.equal(m.tools[0]?.outputSchema, undefined, 'schema-less JSON success admits any shape');
});

test('#72 a non-JSON media alternative forces text-only', async () => {
  const d = doc({
    '/thing': {
      get: {
        operationId: 'getThing',
        responses: {
          '200': {
            description: 'json or xml',
            content: {
              'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } },
              'application/xml': { schema: { type: 'string' } },
            },
          },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  // The API may validly answer XML; advertising the JSON schema would
  // reject that valid non-JSON success.
  assert.equal(m.tools[0]?.outputSchema, undefined, 'a valid non-JSON alternative must not be rejected');
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

test('#65 wildcard response media does not advertise an outputSchema', async () => {
  // Converted Swagger 2.0 without produces arrives as `*/*` content: the
  // API committed to no media type, so a valid plain-text answer must not
  // be rejected against an advertised JSON schema.
  const d = doc({
    '/thing': {
      get: {
        operationId: 'getThing',
        responses: {
          '200': {
            description: 'maybe json, maybe not',
            content: { '*/*': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  assert.equal(m.tools[0]?.outputSchema, undefined, 'wildcard media declares no JSON commitment');
});

test('#76 differing JSON media alternatives under one status force text-only', async () => {
  const d = doc({
    '/thing': {
      get: {
        operationId: 'getThing',
        responses: {
          '200': {
            description: 'json or problem+json',
            content: {
              'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } },
              'application/problem+json': { schema: { type: 'object', properties: { error: { type: 'string' } } } },
            },
          },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  // Both JSON alternatives can be the actual 200 response; advertising the
  // application/json shape would reject a valid problem+json success.
  assert.equal(m.tools[0]?.outputSchema, undefined, 'a valid problem+json 200 must not be rejected');
});

test('#76 a schema-less JSON media alternative under one status forces text-only', async () => {
  const d = doc({
    '/thing': {
      get: {
        operationId: 'getThing',
        responses: {
          '200': {
            description: 'json or unspecified problem+json',
            content: {
              'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } },
              'application/problem+json': {},
            },
          },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  // The schema-less JSON alternative admits any shape.
  assert.equal(m.tools[0]?.outputSchema, undefined, 'schema-less JSON alternative admits any shape');
});

test('#76 agreeing JSON media alternatives under one status are advertised', async () => {
  const shape = { type: 'object', properties: { id: { type: 'string' } } };
  const d = doc({
    '/thing': {
      get: {
        operationId: 'getThing',
        responses: {
          '200': {
            description: 'same shape as json and vendor json',
            content: {
              'application/json': { schema: shape },
              'application/vnd.example+json': { schema: shape },
            },
          },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  assert.equal(m.tools[0]?.outputSchema?.type, 'object', 'equal shapes across JSON alternatives are honest');
});

test('#116 a json-seq success does not advertise an outputSchema', async () => {
  // application/json-seq bodies are not single JSON documents: the runtime
  // cannot produce structured content for them, so advertising would make
  // every valid response isError (#116).
  const d = doc({
    '/events': {
      get: {
        operationId: 'streamEvents',
        responses: {
          '200': {
            description: 'json-seq stream',
            content: { 'application/json-seq': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  assert.equal(m.tools[0]?.outputSchema, undefined, 'only exact application/json or +json advertises');
});

test('#116 a +json suffix success still advertises', async () => {
  const d = doc({
    '/thing': {
      get: {
        operationId: 'getThing',
        responses: {
          '200': {
            description: 'hal+json',
            content: { 'application/hal+json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
        },
      },
    },
  });
  await init(d);
  const m = buildManifest(d);
  assert.equal(m.tools[0]?.outputSchema?.type, 'object', 'the +json suffix is exact-JSON');
});
