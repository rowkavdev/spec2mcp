import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { OpenAPIV3 } from 'openapi-types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server> };

test('#143 operation servers override path servers, which override root', async () => {
  const seen: string[] = [];
  const apis = ['root', 'path', 'operation'].map(name => createServer((_req, res) => { seen.push(name); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ server: name })); }));
  await Promise.all(apis.map(api => new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))));
  const urls = apis.map(api => `http://127.0.0.1:${(api.address() as {port:number}).port}`);
  const response = { '200': { description: 'ok' } };
  const doc = { openapi: '3.0.3', info: { title: 'Server routes', version: '1' }, components: { schemas: {} }, servers: [{ url: urls[0] }],
    paths: { '/root': { get: { operationId: 'root', responses: response } }, '/path': { servers: [{ url: urls[1] }], get: { operationId: 'path', responses: response } },
      '/operation': { servers: [{ url: urls[1] }], get: { operationId: 'operation', servers: [{ url: '{origin}', variables: { origin: { default: urls[2] } } }], responses: response } } } } as unknown as OpenAPIV3.Document;
  let server: Server | undefined; const client = new Client({ name: 'server-regression', version: '1' });
  try {
    await init(doc); const manifest = buildManifest(doc);
    server = await runHttpServer(manifest, { port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`)));
    for (const name of ['root', 'path', 'operation']) assert.equal((await client.callTool({ name, arguments: {} })).isError, undefined);
    assert.deepEqual(seen, ['root', 'path', 'operation']);
    const override = buildManifest(doc, { baseUrl: 'https://override.example' });
    assert.equal(override.baseUrl, 'https://override.example');
    assert.ok(override.tools.every(t => !t.baseUrl), 'explicit generator override stays global');
  } finally {
    await client.close(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await Promise.all(apis.map(api => new Promise<void>(resolve => api.close(() => resolve()))));
  }
});
