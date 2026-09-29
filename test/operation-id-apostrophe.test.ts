import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { ensureOperationIds, loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

const op = (operationId: string) => ({ operationId, responses: { '204': { description: 'OK' } } });

test('apostrophe-stripped IDs are repaired before Forge indexes them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-id-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(path, JSON.stringify({
      openapi: '3.0.3', info: { title: 'IDs', version: '1' },
      paths: {
        '/a': { get: op("foo'bar") },
        '/b': { get: op('foobar') },
        '/c': { get: op('foobar_2') },
      },
    }));
    const doc = await loadSpec(path);
    assert.deepEqual(['/a', '/b', '/c'].map((p) => doc.paths[p]?.get?.operationId),
      ['foobar', 'foobar_2', 'foobar_2_2']);
    await init(doc);
    const tools = buildManifest(doc).tools;
    assert.equal(tools.length, 3);
    assert.equal(new Set(tools.map((t) => t.name)).size, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repair is idempotent for an effective spec after overlay updates', () => {
  const doc = { paths: { '/a': { get: op('foobar') }, '/b': { get: op("foo'bar") } } } as unknown as OpenAPIV3.Document;
  ensureOperationIds(doc);
  assert.equal(doc.paths['/b']?.get?.operationId, 'foobar_2');
  ensureOperationIds(doc);
  assert.equal(doc.paths['/b']?.get?.operationId, 'foobar_2');
});
