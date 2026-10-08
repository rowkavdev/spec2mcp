import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec, localRefDependencies } from '../src/load.js';

for (const keyword of ['const', 'enum', 'default', 'example', 'examples']) {
  test(`external-looking ${keyword} payload remains literal`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-external-literal-'));
    try {
      const literal = { $ref: './data.json' };
      const value = keyword === 'enum' || keyword === 'examples' ? [literal] : literal;
      const path = join(dir, 'spec.json');
      await writeFile(join(dir, 'data.json'), JSON.stringify({ type: 'integer' }));
      await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Literal', version: '1' }, paths: {},
        components: { schemas: { Payload: { type: 'object', [keyword]: value } } } }));
      const doc = await loadSpec(path);
      assert.deepEqual((doc.components!.schemas!.Payload as any)[keyword], value);
      assert.deepEqual(await localRefDependencies(path), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('a missing literal target is not required for loading or dependency discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-missing-literal-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Literal', version: '1' }, paths: {},
      components: { schemas: { Payload: { type: 'object', default: { $ref: './missing.json' } } } } }));
    await assert.doesNotReject(loadSpec(path));
    assert.deepEqual(await localRefDependencies(path), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const fragment of ['', '#/$defs/Target', '#/Target']) {
  test(`external schema documents preserve data and resolve keyword-named properties (${fragment || 'root'})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-external-schema-'));
    try {
      const path = join(dir, 'spec.json');
      const literal = { $ref: './missing.json', nested: { $ref: './also-missing.yaml' } };
      const target = { type: 'object', const: literal, default: literal, example: literal, properties: {
        const: { $ref: './real.json' }, example: { $ref: './real.json' },
      } };
      await writeFile(join(dir, 'real.json'), JSON.stringify({ type: 'string' }));
      await writeFile(join(dir, 'schema.yaml'), JSON.stringify(fragment === '#/Target' ? { Target: target } : fragment ? { $defs: { Target: target } } : target));
      await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'External schema', version: '1' }, paths: {},
        components: { schemas: { Payload: { $ref: `./schema.yaml${fragment}` } } } }));
      const doc = await loadSpec(path);
      const result = doc.components!.schemas!.Payload as any;
      assert.deepEqual(result.const, literal);
      assert.deepEqual(result.default, literal);
      assert.deepEqual(result.example, literal);
      assert.equal(result.properties.const.type, 'string');
      assert.ok(result.properties.example.type === 'string' || result.properties.example.$ref?.startsWith('#/'));
      assert.deepEqual((await localRefDependencies(path)).sort(), [join(dir, 'real.json'), join(dir, 'schema.yaml')].sort());
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('unused schemas in external documents do not fetch literal payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-external-unused-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(join(dir, 'schemas.json'), JSON.stringify({ $defs: {
      Used: { type: 'string' }, Unused: { type: 'object', default: { $ref: './missing.json' } },
    } }));
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Unused schema', version: '1' }, paths: {},
      components: { schemas: { Payload: { $ref: './schemas.json#/$defs/Used' } } } }));
    await assert.doesNotReject(loadSpec(path));
    assert.deepEqual(await localRefDependencies(path), [join(dir, 'schemas.json')]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('external schema literals survive reference siblings and repeated targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-external-siblings-'));
  try {
    const path = join(dir, 'spec.json');
    const literal = { $ref: './missing.json' };
    await writeFile(join(dir, 'schema.json'), JSON.stringify({ type: 'object', const: literal }));
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Siblings', version: '1' }, paths: {},
      components: { schemas: { First: { $ref: './schema.json', description: 'first' }, Second: { $ref: './schema.json' } } } }));
    const doc = await loadSpec(path);
    const schemas = doc.components!.schemas! as any;
    const result = schemas.First.const ? schemas.First : schemas.Second;
    assert.deepEqual(result.const, literal);
    assert.deepEqual(await localRefDependencies(path), [join(dir, 'schema.json')]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const literalFirst of [true, false]) {
  test(`shared YAML alias keeps literal and schema contexts separate (${literalFirst ? 'literal first' : 'schema first'})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-external-shared-'));
    try {
      const path = join(dir, 'spec.yaml');
      await writeFile(join(dir, 'data.json'), JSON.stringify({ type: 'integer' }));
      const schemas = literalFirst
        ? '    Literal:\n      type: object\n      default: &shared {$ref: "./data.json"}\n    Real: *shared\n'
        : '    Real: &shared {$ref: "./data.json"}\n    Literal:\n      type: object\n      default: *shared\n';
      await writeFile(path, 'openapi: 3.1.0\ninfo: {title: Shared, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n' + schemas);
      const doc = await loadSpec(path);
      const result = doc.components!.schemas! as any;
      assert.deepEqual(result.Literal.default, { $ref: './data.json' });
      assert.deepEqual(result.Real, { type: 'integer' });
      assert.deepEqual(await localRefDependencies(path), [join(dir, 'data.json')]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

for (const literalFirst of [true, false]) {
  test(`external shared YAML alias separates literal and schema contexts (${literalFirst ? 'literal first' : 'schema first'})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-external-shared-document-'));
    try {
      const path = join(dir, 'spec.json');
      await writeFile(join(dir, 'data.json'), JSON.stringify({ type: 'integer' }));
      const fields = literalFirst
        ? 'default: &shared {$ref: "./data.json"}\nproperties:\n  real: *shared\n'
        : 'properties:\n  real: &shared {$ref: "./data.json"}\ndefault: *shared\n';
      await writeFile(join(dir, 'schema.yaml'), 'type: object\n' + fields);
      await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Shared external', version: '1' }, paths: {},
        components: { schemas: { Payload: { $ref: './schema.yaml' } } } }));
      const doc = await loadSpec(path);
      const result = doc.components!.schemas!.Payload as any;
      assert.deepEqual(result.default, { $ref: './data.json' });
      assert.deepEqual(result.properties.real, { type: 'integer' });
      assert.deepEqual((await localRefDependencies(path)).sort(), [join(dir, 'data.json'), join(dir, 'schema.yaml')].sort());
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
