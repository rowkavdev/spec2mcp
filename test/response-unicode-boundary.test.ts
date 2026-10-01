import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { OpenAPIV3 } from 'openapi-types';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
process.env.SPEC2MCP_MAX_RESPONSE_CHARS = '2';
const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server> };
delete process.env.SPEC2MCP_MAX_RESPONSE_CHARS;

test('text response truncation does not split a supplementary Unicode character', async () => {
  const api = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('A😀B'); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const doc = {
    openapi: '3.0.3', info: { title: 'Unicode response', version: '1' }, components: { schemas: {} },
    servers: [{ url: `http://127.0.0.1:${(api.address() as {port:number}).port}` }],
    paths: { '/': { get: { operationId: 'get', responses: { '200': { description: 'ok' } } } } },
  } as unknown as OpenAPIV3.Document;
  let server: Server | undefined;
  const client = new Client({ name: 'unicode-response-regression', version: '1' });
  try {
    await init(doc); server = await runHttpServer(buildManifest(doc), { port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`)));
    const result = await client.callTool({ name: 'get', arguments: {} });
    const text = (result.content as {text:string}[])[0]!.text;
    assert.equal(result.isError, undefined);
    assert.equal(text.split('\n')[0], 'A');
    assert.doesNotMatch(text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    assert.match(text, /showing the first 1/);
  } finally {
    await client.close(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
});
