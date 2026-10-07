import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';

for (const keyword of ['const', 'enum', 'default', 'example', 'examples']) {
  test(`loading preserves literal ${keyword} references while normalizing real refs`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-literal-'));
    try {
      const path = join(dir, 'spec.json');
      const literal = { $ref: '#/components/schemas/A~1B', nested: { $ref: '#/components/schemas/A~1B' } };
      const value = keyword === 'enum' || keyword === 'examples' ? [literal] : literal;
      const schema = { type: 'object', [keyword]: value, properties: {
        // Literal keyword names here are field names, not data containers.
        const: { $ref: '#/components/schemas/A~1B' },
        example: { $ref: '#/components/schemas/A~1B' },
      } };
      await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Literals', version: '1' }, paths: {},
        components: { schemas: { 'A/B': { type: 'string' }, Payload: schema } } }));
      const doc = await loadSpec(path);
      const result = doc.components!.schemas!.Payload as Record<string, any>;
      assert.deepEqual(result[keyword], value);
      assert.equal(result.properties.const.$ref, '#/components/schemas/A_B');
      assert.equal(result.properties.example.$ref, '#/components/schemas/A_B');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('loading does not hoist or cycle-rewrite references inside literal payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-literal-'));
  try {
    const path = join(dir, 'spec.json');
    const literal = { deep: { $ref: '#/components/schemas/Target/properties/a~1b' }, cycle: { $ref: '#/components/schemas/Cycle' } };
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Literals', version: '1' }, paths: {}, components: { schemas: {
      Target: { type: 'object', properties: { 'a/b': { type: 'string' } } },
      Cycle: { $ref: '#/components/schemas/Cycle' },
      Payload: { type: 'object', const: literal, properties: { deep: { $ref: literal.deep.$ref } } },
    } } }));
    const doc = await loadSpec(path);
    const result = doc.components!.schemas!.Payload as Record<string, any>;
    assert.deepEqual(result.const, literal);
    assert.match(result.properties.deep.$ref, /^#\/components\/schemas\/Hoisted_/);
    assert.match((doc.components!.schemas!.Cycle as any).$ref, /^#\/invalid-alias-cycle\//);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const keyword of ['additionalItems', 'dependencies']) {
  test(`loading preserves literal refs in ${keyword} schemas`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-literal-edge-'));
    try {
      const path = join(dir, 'spec.json');
      const literal = { $ref: '#/components/schemas/A~1B' };
      const schema = keyword === 'dependencies'
        ? { type: 'object', dependencies: { field: { const: literal } } }
        : { type: 'array', items: [], additionalItems: { const: literal } };
      await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Literal edges', version: '1' }, paths: {},
        components: { schemas: { 'A/B': { type: 'string' }, Payload: schema } } }));
      const doc = await loadSpec(path);
      assert.deepEqual(doc.components!.schemas!.Payload, schema);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
