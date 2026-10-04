import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

test('path item alias chains retain operations and referencing paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-path-alias-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Aliases', version: '1' },
      components: { pathItems: {
        First: { $ref: '#/components/pathItems/Second', description: 'first override', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] },
        Second: { $ref: '#/components/pathItems/Concrete' },
        Concrete: { get: { responses: { '200': { description: 'ok' } } } },
      } }, paths: { '/one': { $ref: '#/components/pathItems/First', summary: 'outer override' },
        '/two': { $ref: '#/components/pathItems/First' } } }));
    const doc = await loadSpec(path);
    assert.equal(doc.paths['/one']?.description, 'first override');
    assert.equal(doc.paths['/one']?.summary, 'outer override');
    assert.equal((doc.paths['/one'] as any).$ref, undefined);
    const firstParameters = (doc.components as any).pathItems.First.parameters;
    assert.notStrictEqual(doc.paths['/one']!.parameters, doc.paths['/two']!.parameters);
    assert.notStrictEqual(doc.paths['/one']!.parameters, firstParameters);
    doc.paths['/one']!.parameters!.push({ name: 'onlyOne', in: 'query', schema: { type: 'string' } });
    assert.equal(doc.paths['/two']!.parameters!.length, 1);
    assert.equal(firstParameters.length, 1);
    await init(doc);
    assert.deepEqual(buildManifest(doc).tools.map(t => [t.path, t.operationId]), [['/one', 'get_one'], ['/two', 'get_two']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cyclic path item aliases terminate without inventing operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-path-cycle-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Cycle', version: '1' },
      components: { pathItems: { A: { $ref: '#/components/pathItems/B' }, B: { $ref: '#/components/pathItems/A' } } },
      paths: { '/cycle': { $ref: '#/components/pathItems/A' } } }));
    const doc = await loadSpec(path);
    await init(doc);
    assert.deepEqual(buildManifest(doc).tools, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('alias operations are not exposed when their target chain is cyclic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-path-cycle-op-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Cycle operation', version: '1' },
      components: { pathItems: { A: { $ref: '#/components/pathItems/B', get: { responses: { '200': { description: 'ok' } } } }, B: { $ref: '#/components/pathItems/B' } } },
      paths: { '/cycle': { $ref: '#/components/pathItems/A' } } }));
    const doc = await loadSpec(path);
    await init(doc);
    assert.deepEqual(buildManifest(doc).tools, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
