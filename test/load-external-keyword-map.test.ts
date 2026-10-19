import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec, localRefDependencies } from '../src/load.js';

async function writeKeywordMapFixture(keyword: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'external-keyword-map-'));
  const path = join(dir, 'spec.json');
  const map: Record<string, unknown> = { First: { type: 'string' } };
  map[keyword] = { type: 'object', default: { $ref: './missing.json' } };
  await writeFile(join(dir, 'schemas.json'), JSON.stringify(map));
  const schemas: Record<string, unknown> = { First: { $ref: './schemas.json#/First' } };
  schemas[keyword] = { $ref: `./schemas.json#/${keyword}` };
  await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Keyword map', version: '1' }, paths: {},
    components: { schemas } }));
  return { dir, path };
}

for (const keyword of ['type', 'properties']) {
  test(`external schema map entry named ${keyword} keeps literal payloads`, async () => {
    const { dir, path } = await writeKeywordMapFixture(keyword);
    try {
      const doc = await loadSpec(path);
      assert.deepEqual((doc.components!.schemas as Record<string, any>)[keyword].default, { $ref: './missing.json' });
      assert.deepEqual(await localRefDependencies(path), [join(dir, 'schemas.json')]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
