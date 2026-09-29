/**
 * Unit tests for the runtime's compiled SDK outputSchema validators, checking
 * candidate structuredContent before it is attached to a
 * tools/call result. MCP SDK clients hard-error a result whose
 * structuredContent fails the advertised outputSchema, so a drifted API
 * response must be caught here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const { compileOutputValidator } = (await import(
  fileURLToPath(new URL('../runtime/server.mjs', import.meta.url))
)) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

const PET_SCHEMA = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'integer', format: 'int64' },
    name: { type: 'string' },
    tag: { type: ['string', 'null'] },
    owner: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
  },
};

test('a response matching the outputSchema validates', () => {
  const validate = compileOutputValidator(PET_SCHEMA);
  assert.equal(validate({ id: 7, name: 'Rex' }), true);
  assert.equal(validate({ id: 7, name: 'Rex', tag: null, owner: { name: 'Sam' } }), true);
  assert.equal(validate({ id: 7, name: 'Rex', extra: 'undeclared is fine' }), true);
});

test('drifted responses fail validation', () => {
  const validate = compileOutputValidator(PET_SCHEMA);
  assert.equal(validate({ ok: true }), false, 'missing required properties');
  assert.equal(validate({ id: '7', name: 'Rex' }), false, 'wrong scalar type');
  assert.equal(validate({ id: 7, name: 'Rex', tag: 3 }), false, 'value outside a type union');
  assert.equal(validate({ id: 7, name: 'Rex', owner: { name: 42 } }), false, 'nested property drift');
  assert.equal(validate(null), false);
  assert.equal(validate([{ id: 7, name: 'Rex' }]), false, 'array where object is declared');
});

test('integer formats bound the value range', () => {
  const validate = compileOutputValidator(PET_SCHEMA);
  assert.equal(validate({ id: Number.MAX_SAFE_INTEGER + 1, name: 'Rex' }), true, 'SDK int64 accepts integers beyond JS safe range');
  assert.equal(validate({ id: 2 ** 64, name: 'Rex' }), true, 'SDK int64 format does not impose the former safe-integer cap');
  const int32 = compileOutputValidator({ type: 'integer', format: 'int32' });
  assert.equal(int32(2 ** 31 - 1), true);
  assert.equal(int32(2 ** 31), false);
});

test('common string formats are checked', () => {
  const validate = compileOutputValidator({
    type: 'object',
    properties: {
      created: { type: 'string', format: 'date-time' },
      homepage: { type: 'string', format: 'uri' },
      id: { type: 'string', format: 'uuid' },
    },
  });
  assert.equal(validate({ created: '2026-09-29T10:00:00Z', homepage: 'https://example.com/x', id: '123e4567-e89b-42d3-a456-426614174000' }), true);
  assert.equal(validate({ created: 'yesterday' }), false);
  assert.equal(validate({ created: '2026-13-40T10:00:00Z' }), false, 'out-of-range date parts');
  assert.equal(validate({ homepage: 'not a uri' }), false);
  assert.equal(validate({ id: '123-not-a-uuid' }), false);
});

test('constraints beyond type are enforced', () => {
  const validate = compileOutputValidator({
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 5, pattern: '^[a-z]+$' },
      score: { type: 'number', minimum: 0, exclusiveMaximum: 100 },
      role: { enum: ['admin', 'user'] },
      ids: { type: 'array', items: { type: 'integer' }, minItems: 1, uniqueItems: true },
    },
    additionalProperties: false,
  });
  assert.equal(validate({ name: 'rex', score: 50, role: 'user', ids: [1, 2] }), true);
  assert.equal(validate({ name: 'REX' }), false, 'pattern');
  assert.equal(validate({ name: '' }), false, 'minLength');
  assert.equal(validate({ name: 'rex', score: 100 }), false, 'exclusiveMaximum');
  assert.equal(validate({ name: 'rex', role: 'owner' }), false, 'enum');
  assert.equal(validate({ name: 'rex', ids: [] }), false, 'minItems');
  assert.equal(validate({ name: 'rex', ids: [1, 1] }), false, 'uniqueItems');
  assert.equal(validate({ name: 'rex', ids: [1, 'x'] }), false, 'item type');
  assert.equal(validate({ name: 'rex', stray: 1 }), false, 'additionalProperties: false');
});

test('combinators are honoured', () => {
  const validate = compileOutputValidator({
    allOf: [{ type: 'object', required: ['id'] }, { type: 'object', properties: { id: { type: 'integer' } } }],
  });
  assert.equal(validate({ id: 1 }), true);
  assert.equal(validate({ id: 'x' }), false);
  assert.equal(validate({}), false);

  const anyOf = compileOutputValidator({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
  assert.equal(anyOf('x'), true);
  assert.equal(anyOf(1), true);
  assert.equal(anyOf(true), false);

  const oneOf = compileOutputValidator({ oneOf: [{ type: 'integer' }, { minimum: 10 }] });
  assert.equal(oneOf(5), true);
  assert.equal(oneOf(20), false, 'matches both branches');
  // { minimum: 10 } is a no-op on non-numbers, so a string matches exactly one branch.
  assert.equal(oneOf('x'), true);

  const not = compileOutputValidator({ not: { type: 'string' } });
  assert.equal(not(1), true);
  assert.equal(not('x'), false);
});

test('invalid schemas do not silently compile to pass-through', () => {
  for (const schema of [null, undefined, 42, 'nope', { type: 7 }]) {
    assert.throws(() => compileOutputValidator(schema));
  }
});

test('deep schemas are fully validated rather than bypassed', () => {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 40; i++) schema = { type: 'object', properties: { next: schema }, required: ['next'] };
  const validate = compileOutputValidator(schema);
  let value: Record<string, unknown> = { next: 42 };
  for (let i = 0; i < 40; i++) value = { next: value };
  assert.equal(validate(value), false);
});

test('SDK parity for date-time offsets, time zones, email, Unicode length and uniqueItems', () => {
  const corpus: { schema: unknown; valid: unknown; invalid: unknown }[] = [
    { schema: { type: 'string', format: 'date-time' }, valid: '2026-09-29T12:00:00+01:00', invalid: '2026-09-29T12:00:00+99:99' },
    { schema: { type: 'string', format: 'time' }, valid: '12:00:00Z', invalid: '12:00:00' },
    { schema: { type: 'string', format: 'email' }, valid: 'a.b@example.com', invalid: 'a..b@example.com' },
    { schema: { type: 'string', minLength: 2 }, valid: 'a😀', invalid: '😀' },
    { schema: { type: 'array', uniqueItems: true }, valid: [{ a: 1 }, { a: 2 }], invalid: [{ a: 1, b: 2 }, { b: 2, a: 1 }] },
  ];
  for (const { schema, valid, invalid } of corpus) {
    const validate = compileOutputValidator(schema);
    assert.equal(validate(valid), true, `accept ${JSON.stringify(valid)}`);
    assert.equal(validate(invalid), false, `reject ${JSON.stringify(invalid)}`);
  }
});
