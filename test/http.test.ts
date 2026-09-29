import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { createMcpTransformer } from '../src/transformer.js';
import type { Server } from 'node:http';

const fixture = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const runtime = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));

test('generated project serves Streamable HTTP with SSE, independent sessions and localhost protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-http-'));
  const doc = await loadSpec(fixture);
  const forge = await init(doc);
  const files = await forge.transform(createMcpTransformer(doc, { runtimeSource: await readFile(runtime, 'utf8') }));
  await forge.finalize(dir, files, { clean: true });
  const manifest = JSON.parse(await readFile(join(dir, 'operations.json'), 'utf8'));
  const api = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Pet-shaped: the SDK client validates structuredContent against the tool's outputSchema.
    res.end(JSON.stringify({ id: 42, name: 'Rex', path: req.url }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const apiAddress = api.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('missing API port');
  manifest.baseUrl = `http://127.0.0.1:${apiAddress.port}`;
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).scripts['start:http'], 'node server.mjs --transport http');
  // Exercise the runtime that is copied verbatim into each project.
  const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
    runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server>
  };
  const server = await runHttpServer(manifest, { port: 0 });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server port');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clients: Client[] = [];
  try {
    const forbidden = await fetch(url, { method: 'POST', headers: { host: 'evil.example', origin: 'https://evil.example' } });
    assert.equal(forbidden.status, 403);
    const badOrigin = await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);
    const absent = await fetch(new URL('/other', url));
    assert.equal(absent.status, 404);
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: `http-test-${i}`, version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
      clients.push(client);
      assert.ok(transport.sessionId);
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 7);
      const call = await client.callTool({ name: 'get_pet', arguments: { petId: 42 } });
      assert.equal(call.isError, undefined);
      assert.match((call.content as { text: string }[])[0]!.text, /pets\/42/);
    }
    const unknown = await fetch(url, { method: 'GET', headers: { 'mcp-session-id': 'unknown', accept: 'text/event-stream' } });
    assert.equal(unknown.status, 404);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});


test('generated server runs directly with --transport http', async () => {
  // Keep the scratch directory under the repo to resolve the generated project's
  // SDK dependency without adding an install/build step to this test.
  const dir = fileURLToPath(new URL('../.tmp-http-cli/', import.meta.url));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const doc = await loadSpec(fixture);
  const forge = await init(doc);
  const files = await forge.transform(createMcpTransformer(doc, { runtimeSource: await readFile(runtime, 'utf8') }));
  await forge.finalize(dir, files, { clean: true });
  const child = spawn(process.execPath, [join(dir, 'server.mjs'), '--transport', 'http'], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let log = '';
    const endpoint = await new Promise<URL>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server did not listen: ${log}`)), 10_000);
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${log}`)); });
      child.stderr!.on('data', (chunk: Buffer) => {
        log += chunk.toString();
        const found = log.match(/(http:\/\/127\.0\.0\.1:\d+\/mcp)/);
        if (found) { clearTimeout(timeout); resolve(new URL(found[1]!)); }
      });
    });
    const client = new Client({ name: 'generated-http', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    assert.equal((await client.listTools()).tools.length, 7);
    await client.close();
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
