import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';

test('type union normalization does not rewrite const, enum or default payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'type-union-literals-'));
  const literal = { type: ['integer', 'string'], nested: { type: ['string', 'null'] } };
  try {
    const file = join(dir, 'spec.json');
    await writeFile(file, JSON.stringify({ openapi: '3.1.0', info: { title: 'Literal types', version: '1' }, paths: {}, components: { schemas: {
      Payload: { type: 'object', const: literal, enum: [literal], default: literal, properties: { actual: { type: ['integer', 'string'] }, default: { type: ['string', 'null'] }, enum: { type: ['integer', 'string'] }, const: { type: ['integer', 'null'] } }, $defs: { default: { type: ['string', 'null'] } }, patternProperties: { enum: { type: ['integer', 'null'] } } },
    } } }));
    const doc = await loadSpec(file);
    const schema = doc.components!.schemas!.Payload as Record<string, unknown>;
    assert.deepEqual(schema.const, literal);
    assert.deepEqual(schema.enum, [literal]);
    assert.deepEqual(schema.default, literal);
    assert.deepEqual((schema.properties as Record<string, unknown>).default, { type: 'string', nullable: true });
    assert.deepEqual((schema.properties as Record<string, unknown>).enum, { anyOf: [{ type: 'integer' }, { type: 'string' }] });
    assert.deepEqual((schema.properties as Record<string, unknown>).const, { type: 'integer', nullable: true });
    assert.deepEqual((schema.$defs as Record<string, unknown>).default, { type: 'string', nullable: true });
    assert.deepEqual((schema.patternProperties as Record<string, unknown>).enum, { type: 'integer', nullable: true });
    assert.deepEqual((schema.properties as Record<string, unknown>).actual, { anyOf: [{ type: 'integer' }, { type: 'string' }] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
