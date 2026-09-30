import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { OpenAPIV3 } from 'openapi-types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server> };

test('#158 unsafe integer response tokens remain exact text and never rounded structured content', async () => {
  let body = '{"id":9007199254740993}';
  const api = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const doc = { openapi: '3.0.3', info: { title: 'Precision', version: '1' }, components: { schemas: {} }, servers: [{ url: `http://127.0.0.1:${(api.address() as {port:number}).port}` }],
    paths: { '/': { get: { operationId: 'get', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } } } } } } } } as unknown as OpenAPIV3.Document;
  let server: Server | undefined; const client = new Client({ name: 'precision-regression', version: '1' });
  try {
    await init(doc); server = await runHttpServer(buildManifest(doc), { port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`)));
    for (const token of ['9007199254740993', '-9007199254740993', '9.007199254740993e15']) {
      body = `{"id":${token}}`;
      const result = await client.callTool({ name: 'get', arguments: {} });
      assert.equal(result.structuredContent, undefined);
      assert.equal(result.isError, true);
      assert.ok(JSON.stringify(result.content).includes(token));
      assert.match(JSON.stringify(result.content), /precision/i);
    }
    body = '{"id":42,"label":"9007199254740993"}';
    const safe = await client.callTool({ name: 'get', arguments: {} });
    assert.equal(safe.isError, undefined); assert.equal((safe.structuredContent as {id:number}).id, 42);
  } finally {
    await client.close(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
});
