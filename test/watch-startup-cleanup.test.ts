import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchSpec } from '../src/watch.js';

test('a failed URL watch startup stops polling when no handle can be returned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-watch-startup-'));
  const originalFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => { hits++; return new Response('spec'); };
  try {
    await assert.rejects(watchSpec('https://example.invalid/spec', async () => {}, {
      pollIntervalMs: 10, additionalInputs: [join(dir, 'missing', 'overlay.yaml')], log() {},
    }), /ENOENT/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(hits, 0, 'a failed watcher must not keep fetching in the background');
  } finally { globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
});
