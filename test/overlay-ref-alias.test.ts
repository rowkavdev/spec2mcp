import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localOverlayReferencePaths } from '../src/load.js';

test('lexical overlay reference scanning terminates on recursive YAML aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlay-ref-alias-'));
  try {
    const overlay = join(dir, 'overlay.yaml');
    await writeFile(overlay, [
      'overlay: 1.0.0', 'info: {title: alias, version: "1"}', 'actions: []',
      'x-data: &data', '  $ref: ./schema.json', '  self: *data',
    ].join('\n'));
    assert.deepEqual(await localOverlayReferencePaths(join(dir, 'spec.json'), [overlay]), [join(dir, 'schema.json')]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
