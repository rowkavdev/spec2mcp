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
  // #61: when the ranked success statuses declare different shapes, no
  // single outputSchema is honest - advertise nothing rather than reject a
  // valid response from a lower-ranked status against the winner's schema.
  assert.equal(properties('priority'), undefined);
  assert.equal(properties('range_priority'), undefined);
});

test('#141 writeOnly required fields leave the output schema but stay required on input', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Secrets', version: '1' },
    components: { schemas: {} },
    paths: { '/': {
      post: {
        operationId: 'create',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['password', 'name'],
          properties: { password: { type: 'string', writeOnly: true }, name: { type: 'string' } },
        } } } },
        responses: { '200': response('ok') },
      },
      get: {
        operationId: 'get',
        responses: { '200': response('ok') },
      },
    } },
  } as unknown as OpenAPIV3.Document;
  // Both operations share one response shape: a required writeOnly property
  // plus a nested object that also requires one.
  const responseSchema = {
    type: 'object', required: ['password', 'id', 'profile'],
    properties: {
      password: { type: 'string', writeOnly: true },
      id: { type: 'string', readOnly: true },
      profile: { type: 'object', required: ['secret', 'display'], properties: {
        secret: { type: 'string', writeOnly: true }, display: { type: 'string' },
      } },
    },
  };
  for (const op of Object.values(doc.paths['/'] as Record<string, unknown>)) {
    (op as { responses: Record<string, unknown> }).responses['200'] = {
      description: 'ok', content: { 'application/json': { schema: responseSchema } },
    };
  }
  await init(doc);
  const m = buildManifest(doc);
  const out = m.tools.find((t) => t.operationId === 'get')?.outputSchema as {
    required?: string[];
    properties: Record<string, { required?: string[] }>;
  };
  assert.deepEqual(out.required, ['id', 'profile'], 'writeOnly leaves response required; readOnly stays');
  assert.deepEqual(out.properties.profile?.required, ['display'], 'nested writeOnly stripped too');
  // The same fields stay required on the request side: the scopes must not
  // be conflated.
  const input = m.tools.find((t) => t.operationId === 'create')?.inputSchema as { required?: string[] };
  assert.ok(input.required?.includes('password'), 'request side keeps the writeOnly requirement');
});

test('#141 writeOnly stripping never rewrites const, enum, default or examples literal data', async () => {
  const literal = { required: ['secret'], properties: { secret: { writeOnly: true } } };
  const doc = {
    openapi: '3.0.3', info: { title: 'Literals', version: '1' },
    components: { schemas: {} },
    paths: { '/': { get: { operationId: 'get', responses: { '200': {
      description: 'ok', content: { 'application/json': { schema: {
        type: 'object',
        required: ['password', 'id'],
        properties: {
          password: { type: 'string', writeOnly: true },
          id: { type: 'string' },
          blob: {
            type: 'object',
            const: literal,
            default: literal,
            examples: [literal],
            enum: [literal, { plain: true }],
          },
        },
      } } },
    } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const out = buildManifest(doc).tools.find((t) => t.operationId === 'get')?.outputSchema as {
    required?: string[];
    properties: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(out.required, ['id'], 'schema positions still strip writeOnly');
  const blob = out.properties.blob ?? {};
  assert.deepEqual(blob.const, literal, 'const literal preserved verbatim');
  assert.deepEqual(blob.default, literal, 'default literal preserved verbatim');
  assert.deepEqual(blob.examples, [literal], 'examples literal preserved verbatim');
  assert.deepEqual(blob.enum, [literal, { plain: true }], 'enum literals preserved verbatim');
});

test('allOf response required lists do not require writeOnly fields declared in sibling branches', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Composed output', version: '1' }, components: { schemas: {} },
    paths: { '/': { get: { operationId: 'get', responses: { '200': { description: 'ok', content: { 'application/json': { schema: {
      type: 'object', allOf: [
        { type: 'object', properties: { secret: { type: 'string', writeOnly: true }, id: { type: 'integer' } } },
        { type: 'object', required: ['secret', 'id'] },
      ],
    } } } } } } } },
  } as unknown as OpenAPIV3.Document;
  await init(doc);
  const schema = buildManifest(doc).tools[0]!.outputSchema!;
  const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
  const validate = compileOutputValidator(schema);
  assert.equal(validate({ id: 1 }), true);
  assert.equal(validate({}), false);
});
