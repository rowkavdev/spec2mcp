import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOverlays } from '../src/load.js';

for (const kind of ['object', 'array']) {
  test(`overlay loader rejects cyclic ${kind} update aliases before application`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlay-update-cycle-'));
    try {
      const path = join(dir, 'overlay.yaml');
      const update = kind === 'object' ? '  update: &update\n    self: *update' : '  update:\n    enum: &values [*values]';
      await writeFile(path, `overlay: 1.0.0\ninfo: {title: test, version: "1"}\nactions:\n- target: $.info\n${update}\n`);
      await assert.rejects(loadOverlays([path]), /[Cc]ycl/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('overlay loader permits shared acyclic YAML update aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlay-shared-update-'));
  try {
    const path = join(dir, 'overlay.yaml');
    await writeFile(path, 'overlay: 1.0.0\ninfo: {title: test, version: "1"}\nactions:\n- target: $.info\n  update:\n    first: &value {description: safe}\n    second: *value\n');
    assert.equal((await loadOverlays([path])).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('overlay loader leaves unused recursive extension data available to lexical reference scanning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlay-extension-cycle-'));
  try {
    const path = join(dir, 'overlay.yaml');
    await writeFile(path, 'overlay: 1.0.0\ninfo: {title: test, version: "1"}\nactions: []\nx-data: &data\n  $ref: ./schema.json\n  self: *data\n');
    assert.equal((await loadOverlays([path])).length, 1);
    const { localOverlayReferencePaths } = await import('../src/load.js');
    assert.deepEqual(await localOverlayReferencePaths(join(dir, 'spec.json'), [path]), [join(dir, 'schema.json')]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
