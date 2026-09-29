/**
 * External $ref bundling: relative refs in a file-based spec must resolve
 * against the spec's own directory, not the process working directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

const MAIN = fileURLToPath(new URL('./fixtures/external/main.yaml', import.meta.url));

test('relative external $refs resolve against the spec location', async () => {
  const doc = await loadSpec(MAIN);
  await init(doc);
  const m = buildManifest(doc);
  assert.equal(m.tools.length, 1);
  assert.equal(m.tools[0]?.name, 'list_widgets');
  // The external schema was bundled into the document: no file-path $ref remains.
  assert.doesNotMatch(JSON.stringify(doc), /schemas\.yaml/);
});
