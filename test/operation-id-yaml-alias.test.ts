import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

for (const sharedPathItem of [false, true]) {
  test(`operation ID repair separates YAML ${sharedPathItem ? 'path item' : 'operation'} aliases`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-id-alias-'));
    try {
      const path = join(dir, 'spec.yaml');
      await writeFile(path, [
        'openapi: 3.0.3', 'info: {title: Alias, version: "1"}', 'paths:',
        sharedPathItem ? '  /a: &shared' : '  /a:',
        sharedPathItem ? '    get:' : '    get: &shared',
        '      responses: {"200": {description: OK}}',
        sharedPathItem ? '  /b: *shared' : '  /b:\n    get: *shared',
      ].join('\n'));
      const doc = await loadSpec(path);
      assert.deepEqual(['/a', '/b'].map((p) => doc.paths[p]?.get?.operationId), ['get_a', 'get_b']);
      await init(doc);
      assert.equal(buildManifest(doc).tools.length, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
