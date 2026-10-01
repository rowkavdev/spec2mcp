import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

test('3.1 type unions intersect an existing anyOf instead of replacing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'type-union-intersection-'));
  try {
    const file = join(dir, 'spec.json');
    await writeFile(file, JSON.stringify({
      openapi: '3.1.0', info: { title: 'Type intersection', version: '1' },
      paths: { '/': { get: { operationId: 'get', responses: { '200': { description: 'ok', content: { 'application/json': { schema: {
        type: ['integer', 'string'], anyOf: [{ const: 'safe' }, { const: 3 }], allOf: [{ not: { const: 'blocked' } }],
      } } } } } } } },
    }));
    const doc = await loadSpec(file);
    await init(doc);
    const tool = buildManifest(doc).tools[0]!;
    assert.equal(tool.outputWrap, true);
    const validate = compileOutputValidator(tool.outputSchema);
    for (const result of ['safe', 3]) assert.equal(validate({ result }), true);
    for (const result of ['unsafe', 999, true, 1.5, null]) assert.equal(validate({ result }), false, JSON.stringify(result));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
