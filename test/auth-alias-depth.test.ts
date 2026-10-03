import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { buildAuthPlan } from '../src/auth.js';

function document(schemes: Record<string, unknown>): OpenAPIV3.Document {
  return { openapi: '3.0.3', info: { title: 'Aliases', version: '1' }, paths: {}, components: { securitySchemes: schemes } } as OpenAPIV3.Document;
}
test('security aliases deeper than five hops keep their requested scheme identity', () => {
  const schemes: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) schemes[`Alias${i}`] = { $ref: `#/components/securitySchemes/Alias${i + 1}` };
  schemes.Alias12 = { type: 'http', scheme: 'bearer' };
  const { auth, forOperation } = buildAuthPlan(document(schemes), 'ALIASES');
  const selected = forOperation({ security: [{ Alias0: [] }], responses: {} }, 'GET /');
  assert.deepEqual(selected.names, ['Alias0']);
  assert.equal(auth.schemes[0]?.schemeName, 'Alias0');
  assert.equal(auth.schemes[0]?.envVar, 'ALIASES_ALIAS0');
  assert.deepEqual(auth.warnings, []);
});
test('cyclic and dangling security aliases terminate with a warning', () => {
  for (const schemes of [
    { A: { $ref: '#/components/securitySchemes/B' }, B: { $ref: '#/components/securitySchemes/A' } },
    { A: { $ref: '#/components/securitySchemes/Missing' } },
  ]) {
    const { auth, forOperation } = buildAuthPlan(document(schemes), 'ALIASES');
    assert.deepEqual(forOperation({ security: [{ A: [] }], responses: {} }, 'GET /').names, []);
    assert.match(auth.warnings.join('\n'), /missing or unsupported/);
  }
});

test('security aliases decode percent-encoded URI fragments before JSON Pointer escapes', () => {
  const { auth, forOperation } = buildAuthPlan(document({
    'Bearer Auth/é': { type: 'http', scheme: 'bearer' },
    Alias: { $ref: '#/components/securitySchemes/Bearer%20Auth~1%C3%A9' },
  }), 'ALIASES');
  assert.deepEqual(forOperation({ security: [{ Alias: [] }], responses: {} }, 'GET /').names, ['Alias']);
  assert.equal(auth.schemes[0]?.schemeName, 'Alias');
  assert.deepEqual(auth.warnings, []);
});

test('malformed percent-encoded security fragments remain unsupported without crashing', () => {
  const { auth, forOperation } = buildAuthPlan(document({
    Alias: { $ref: '#/components/securitySchemes/%ZZ' },
  }), 'ALIASES');
  assert.deepEqual(forOperation({ security: [{ Alias: [] }], responses: {} }, 'GET /').names, []);
  assert.match(auth.warnings.join('\n'), /missing or unsupported/);
});
