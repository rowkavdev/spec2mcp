import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { OpenAPIV3 } from 'openapi-types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server> };

test('JSON cookie content preserves its schema and serializes as a single encoded cookie', async () => {
  const seen: string[] = [];
  const api = createServer((req, res) => { seen.push(req.headers.cookie ?? ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const doc = {
    openapi: '3.0.3', info: { title: 'Cookie content', version: '1' },
    components: { schemas: {} },
    servers: [{ url: `http://127.0.0.1:${(api.address() as {port:number}).port}` }],
    paths: { '/': { get: {
      operationId: 'get',
      parameters: [{ name: 'filter', in: 'cookie', required: true,
        content: { 'application/json': { schema: {
          type: 'object', properties: { id: { type: 'integer' } },
          required: ['id'], additionalProperties: false,
        } } },
      }],
      responses: { '200': { description: 'ok' } },
    } } },
  } as unknown as OpenAPIV3.Document;
  let server: Server | undefined;
  const client = new Client({ name: 'cookie-content-regression', version: '1' });
  try {
    await init(doc);
    const manifest = buildManifest(doc);
    assert.equal(manifest.tools[0]!.args[0]!.schema.type, 'object');
    server = await runHttpServer(manifest, { port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`)));
    const good = await client.callTool({ name: 'get', arguments: { filter: { id: 1 } } });
    assert.equal(good.isError, undefined);
    assert.equal(seen.at(-1), 'filter=%7B%22id%22%3A1%7D');
    const before = seen.length;
    const bad = await client.callTool({ name: 'get', arguments: { filter: { id: 1.5 } } });
    assert.equal(bad.isError, true);
    assert.equal(seen.length, before);
  } finally {
    await client.close(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
});
