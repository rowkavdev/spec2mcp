import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';

for (const [extension, pointer] of [
  ['x-metadata: &meta\n  self: *meta', '/x-metadata/self'],
  ['x-metadata: &meta\n  children: [*meta]', '/x-metadata/children/0'],
] as const) {
  test(`cyclic YAML objects are rejected with the cycle location ${pointer}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-yaml-cycle-'));
    try {
      const path = join(dir, 'spec.yaml');
      await writeFile(path, `openapi: 3.0.3\ninfo: {title: Cycle, version: "1"}\npaths: {}\n${extension}\n`);
      await assert.rejects(loadSpec(path), (error: unknown) =>
        error instanceof Error && !(error instanceof RangeError) && /cyclic object graph/i.test(error.message) && error.message.includes(pointer));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('shared non-cyclic YAML aliases remain supported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-yaml-shared-'));
  try {
    const path = join(dir, 'spec.yaml');
    await writeFile(path, 'openapi: 3.0.3\ninfo: {title: Shared, version: "1"}\npaths: {}\nx-first: &meta {value: 1}\nx-second: *meta\n');
    const doc = await loadSpec(path) as any;
    assert.deepEqual(doc['x-first'], { value: 1 });
    assert.deepEqual(doc['x-second'], { value: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
