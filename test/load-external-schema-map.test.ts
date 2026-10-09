import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec, localRefDependencies } from '../src/load.js';

test('multiple fragments in an external plain schema map preserve all literal payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'external-schema-map-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(join(dir, 'schemas.json'), JSON.stringify({
      First: { type: 'string' }, Second: { type: 'object', default: { $ref: './missing.json' } },
    }));
    await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Map', version: '1' }, paths: {},
      components: { schemas: { First: { $ref: './schemas.json#/First' }, Second: { $ref: './schemas.json#/Second' } } } }));
    const doc = await loadSpec(path);
    assert.deepEqual((doc.components!.schemas!.Second as any).default, { $ref: './missing.json' });
    assert.deepEqual(await localRefDependencies(path), [join(dir, 'schemas.json')]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
