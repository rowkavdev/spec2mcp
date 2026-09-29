import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { applyOverlays } from '../src/overlay.js';
import { loadOverlays, loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';
import { readProjectConfig, resolveConfig } from '../src/config.js';

const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const OVERLAY = fileURLToPath(new URL('./fixtures/curate-overlay.yaml', import.meta.url));

test('overlays rename, remove and re-describe tools before generation', async () => {
  const overlays = await loadOverlays([OVERLAY]);
  const doc = applyOverlays(await loadSpec(PETSTORE), overlays);
  await init(doc);
  const m = buildManifest(doc);
  const names = m.tools.map((t) => t.name);
  assert.ok(names.includes('fetch_pet'), 'renamed operationId drives the tool name');
  assert.ok(!names.includes('get_pet'), 'old name is gone');
  assert.ok(!names.includes('delete_pet'), 'removed operation produces no tool');
  assert.equal(m.tools.length, 6);
  assert.equal(m.tools.find((t) => t.name === 'list_pets')?.description, 'List every pet currently in the store.');
});

test('an overlay targeting a missing operationId fails loudly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-ov-'));
  try {
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, [
      'overlay: 1.0.0',
      'info: { title: bad, version: 1.0.0 }',
      'actions:',
      "  - target: $.paths.*[?(@.operationId=='noSuchOperation')]",
      '    update: { description: nope }',
    ].join('\n'));
    const spec = await loadSpec(PETSTORE);
    const overlays = await loadOverlays([bad]);
    assert.throws(() => applyOverlays(spec, overlays), /noSuchOperation/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a non-overlay file is rejected before Forge sees it', async () => {
  await assert.rejects(loadOverlays([PETSTORE]), /not an OpenAPI Overlay document/);
});
