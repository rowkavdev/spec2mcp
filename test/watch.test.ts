import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchSpec } from '../src/watch.js';

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for regeneration');
}

test('local watch regenerates on atomic replacement but not unchanged content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-watch-'));
  const file = join(dir, 'spec.yaml');
  let count = 0;
  let handle;
  try {
    await writeFile(file, 'first');
    handle = await watchSpec(file, async () => { count++; }, { log() {} });
    assert.equal(count, 1);
    await writeFile(join(dir, 'replacement'), 'second');
    await rename(join(dir, 'replacement'), file);
    await until(() => count === 2);
    await writeFile(file, 'second');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(count, 2);
  } finally {
    handle?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('URL watch polls, retains last successful version and retries failed generation', async () => {
  let content = 'first';
  let count = 0;
  let fail = false;
  const server = createServer((_req, res) => res.end(content));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let handle;
  try {
    handle = await watchSpec(`http://127.0.0.1:${address.port}/spec.yaml`, async () => {
      count++;
      if (fail) throw new Error('invalid spec');
    }, { pollIntervalMs: 30, log() {} });
    assert.equal(count, 1);
    content = 'second';
    await until(() => count === 2);
    fail = true;
    content = 'third';
    await until(() => count >= 3);
    fail = false;
    await until(() => count >= 4);
    const settled = count;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(count, settled);
  } finally {
    handle?.close();
    server.close();
  }
});

test('#187 close prevents generation after a pending URL digest', async () => {
  let body = 'v1';
  let hits = 0;
  let pollStarted!: () => void;
  let releasePoll!: () => void;
  const started = new Promise<void>((resolve) => { pollStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releasePoll = resolve; });
  const api = createServer(async (_req, res) => {
    hits++;
    if (hits === 2) { pollStarted(); await gate; }
    res.end(body);
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  let generations = 0;
  let watcher;
  try {
    watcher = await watchSpec(`http://127.0.0.1:${address.port}/spec`,
      async () => { generations++; }, { pollIntervalMs: 20, log() {} });
    assert.equal(generations, 1);
    body = 'v2';
    await started;
    watcher.close();
    releasePoll();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(generations, 1);
  } finally {
    watcher?.close(); releasePoll(); api.close();
  }
});

test('#157 URL body timeout permits later healthy generations', async () => {
  let hits = 0, generations = 0;
  const api = createServer((_req, res) => {
    hits++;
    if (hits === 2) { res.writeHead(200); res.write('partial'); return; }
    res.end(hits === 1 ? 'first' : 'second');
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address(); assert.ok(address && typeof address !== 'string');
  let handle;
  try {
    handle = await watchSpec(`http://127.0.0.1:${address.port}/spec`, async () => { generations++; }, { pollIntervalMs: 20, requestTimeoutMs: 60, log() {} });
    await until(() => generations === 2);
    assert.ok(hits >= 3);
  } finally { handle?.close(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); }
});
