/**
 * #148: a $ref alias chain that never reaches a concrete schema (A -> B ->
 * A) must not crash generation with RangeError: Maximum call stack size
 * exceeded. The cycle is broken at load and treated as unresolvable (#112
 * behavior: a warning, and the affected tool stays text-only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

test('#148 an alias cycle resolves to a bounded warning, not a stack overflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-cycle-'));
  try {
    const specPath = join(dir, 'spec.json');
    await writeFile(specPath, JSON.stringify({
      openapi: '3.0.3', info: { title: 'R', version: '1' },
      paths: { '/items': { get: { operationId: 'getItems', responses: { '200': {
        description: 'OK',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } },
      } } } } },
      components: { schemas: {
        A: { $ref: '#/components/schemas/B' },
        B: { $ref: '#/components/schemas/A' },
      } },
    }));
    const doc = await loadSpec(specPath);
    await init(doc);
    const manifest = buildManifest(doc);
    const tool = manifest.tools.find((t) => t.operationId === 'getItems');
    assert.ok(tool, 'the operation still becomes a tool');
    assert.equal(tool.outputSchema, undefined, 'no output schema is advertised for an unresolvable cycle');
    assert.ok(
      (manifest.warnings ?? []).some((w) => w.includes('#/components/schemas/A') || w.includes('invalid-alias-cycle')),
      'the unresolved ref is surfaced loudly in the manifest warnings',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
