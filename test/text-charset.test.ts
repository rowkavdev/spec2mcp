/**
 * Regression tests for #131: the runtime discarded the declared response
 * charset and decoded every non-XML text body as UTF-8 with replacement,
 * silently corrupting successful responses. Drives a real MCP client over
 * Streamable HTTP against a mock API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let api: Server;
let server: Server;
let client: Client;

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };
const callTool = (name: string) =>
  client.callTool({ name, arguments: {} }) as Promise<ToolResult>;

before(async () => {
  api = createServer((req, res) => {
    if (req.url === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }).end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    } else if (req.url === '/bogus') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=x-bogus-charset' }).end('abc');
    } else if (req.url === '/badutf8') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(Buffer.from([0x63, 0xe9]));
    } else if (req.url === '/jsonlatin1') {
      res.writeHead(200, { 'content-type': 'application/json; charset=iso-8859-1' }).end(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d]));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress !== 'string');
  const tool = (path: string) => ({ name: `read${path.replace('/', '_')}`, method: 'GET', path, args: [], inputSchema: { type: 'object', properties: {} } });
  const manifest = {
    serverName: 'charset', apiTitle: 'charset', apiVersion: '1',
    baseUrl: `http://127.0.0.1:${apiAddress.port}`,
    auth: { schemes: [] },
    tools: ['/latin1', '/bogus', '/badutf8', '/jsonlatin1'].map(tool),
  };
  const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
    runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server>
  };
  server = await runHttpServer(manifest, { port: 0 });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  client = new Client({ name: 'charset-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
});

after(async () => {
  await client?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  await new Promise<void>((r) => api?.close(() => r()));
});

test('#131 a declared charset renders the response text correctly', async () => {
  const res = await callTool('read_latin1');
  assert.ok(!res.isError, `call failed: ${res.content?.[0]?.text ?? ''}`);
  assert.equal(res.content?.[0]?.text, 'café');
});

test('#131 an unsupported declared charset is an explicit tool error, not replacement bytes', async () => {
  const res = await callTool('read_bogus');
  assert.ok(res.isError, 'an undecodable response must not succeed');
  assert.match(res.content?.[0]?.text ?? '', /could not be decoded with the declared charset "x-bogus-charset"/);
});

test('#131 bytes invalid for the declared charset are an explicit tool error', async () => {
  const res = await callTool('read_badutf8');
  assert.ok(res.isError, 'an undecodable response must not succeed');
  assert.match(res.content?.[0]?.text ?? '', /could not be decoded with the declared charset "utf-8"/);
});

test('#131 JSON stays strict UTF-8 even when another charset is declared', async () => {
  const res = await callTool('read_jsonlatin1');
  assert.ok(res.isError, 'Latin-1 bytes in a declared JSON body must not parse');
  assert.match(res.content?.[0]?.text ?? '', /not valid JSON/);
});
