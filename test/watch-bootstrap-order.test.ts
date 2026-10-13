import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchSpec, type WatchHandle } from '../src/watch.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Hold the exact async filesystem boundary rather than depending on CPU load.
test('URL startup cannot poll while slow watcher setup is pending and then fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-bootstrap-failure-'));
  const missing = join(dir, 'missing', 'overlay.yaml');
  const originalRealpath = fsPromises.realpath;
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let hits = 0, generations = 0;
  const patched = mock.method(fsPromises, 'realpath', async (file: any, ...args: any[]) => {
    if (file === missing) { entered(); await gate; }
    return (originalRealpath as any)(file, ...args);
  });
  syncBuiltinESMExports();
  globalThis.fetch = async () => { hits++; return new Response('spec'); };
  const startup = watchSpec('https://example.invalid/spec', async () => { generations++; }, {
    pollIntervalMs: 10, additionalInputs: [missing], log() {},
  });
  const rejected = assert.rejects(startup, /ENOENT/);
  try {
    await started;
    await delay(60);
    assert.equal(hits, 0, 'bootstrap must not start HTTP while watcher setup is unresolved');
    release();
    await rejected;
    await delay(60);
    assert.equal(hits, 0, 'failed bootstrap must never fetch');
    assert.equal(generations, 0);
  } finally {
    release(); await rejected;
    patched.mock.restore(); syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('URL polling starts after slow initial generation, then stops on close', async () => {
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let hits = 0, generations = 0;
  let handle: WatchHandle | undefined;
  let content = 'first';
  globalThis.fetch = async () => { hits++; return new Response(content); };
  const startup = watchSpec('https://example.invalid/spec', async () => {
    generations++;
    if (generations === 1) { entered(); await gate; }
  }, { pollIntervalMs: 10, log() {} });
  try {
    await started;
    await delay(60);
    assert.equal(hits, 1, 'only the initial digest runs during bootstrap');
    release(); handle = await startup;
    assert.equal(generations, 1);
    content = 'second';
    for (let i = 0; i < 100 && generations < 2; i++) await delay(10);
    assert.equal(generations, 2);
    assert.ok(hits >= 2);
    handle.close();
    const settled = hits;
    await delay(60);
    assert.equal(hits, settled);
  } finally {
    release(); handle ??= await startup; handle.close();
    globalThis.fetch = originalFetch;
  }
});
