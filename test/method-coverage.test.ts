import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

const METHODS_SPEC = fileURLToPath(new URL('./fixtures/http-methods.yaml', import.meta.url));

test('#46 all eight HTTP methods become tools', async () => {
  const doc = await loadSpec(METHODS_SPEC);
  await init(doc);
  const m = buildManifest(doc);

  assert.equal(m.tools.length, 8, 'head/options/trace operations are indexed alongside the other five');
  const byMethod = new Map(m.tools.map((t) => [t.method, t.name]));
  assert.deepEqual(
    [...byMethod.keys()].sort(),
    ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'],
  );
  assert.equal(byMethod.get('HEAD'), 'head_thing');
  assert.equal(byMethod.get('OPTIONS'), 'options_thing');
  assert.equal(byMethod.get('TRACE'), 'trace_thing');
  for (const t of m.tools) {
    assert.equal(t.path, '/thing');
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
  }
});
