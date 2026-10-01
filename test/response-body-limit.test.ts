import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { OpenAPIV3 } from 'openapi-types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
process.env.SPEC2MCP_MAX_RESPONSE_BYTES = '1024';
const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server> };
delete process.env.SPEC2MCP_MAX_RESPONSE_BYTES;

test('runtime stops oversized chunked responses before decoding or returning content', async () => {
  let mode = 'chunked';
  const api = createServer((_req, res) => {
    const oversized = 'x'.repeat(1800);
    if (mode === 'gzip') {
      const compressed = gzipSync(oversized);
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': compressed.length });
      res.end(compressed);
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      if (mode === 'chunked') { res.write('x'.repeat(900)); res.end('y'.repeat(900)); }
      else if (mode === 'exact') res.end('x'.repeat(1024));
      else res.end('normal response');
    }
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const doc = { openapi: '3.0.3', info: { title: 'Bounded response', version: '1' }, components: { schemas: {} }, servers: [{ url: `http://127.0.0.1:${(api.address() as {port:number}).port}` }],
    paths: { '/': { get: { operationId: 'get', responses: { '200': { description: 'ok' } } } } } } as unknown as OpenAPIV3.Document;
  let server: Server | undefined;
  const client = new Client({ name: 'response-limit-regression', version: '1' });
  try {
    await init(doc); server = await runHttpServer(buildManifest(doc), { port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`)));
    for (const variant of ['chunked', 'gzip']) {
      mode = variant;
      const oversized = await client.callTool({ name: 'get', arguments: {} });
      assert.equal(oversized.isError, true, variant);
      assert.match(JSON.stringify(oversized.content), /response body exceeds.*1024.*byte/i);
      assert.ok(JSON.stringify(oversized.content).length < 300);
    }
    mode = 'exact';
    const boundary = await client.callTool({ name: 'get', arguments: {} });
    assert.equal(boundary.isError, undefined);
    mode = 'normal';
    const normal = await client.callTool({ name: 'get', arguments: {} });
    assert.equal(normal.isError, undefined);
    assert.match(JSON.stringify(normal.content), /normal response/);
  } finally {
    await client.close(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
});
