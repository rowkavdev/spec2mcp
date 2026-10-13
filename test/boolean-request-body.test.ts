import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
test('false JSON body schema remains unsatisfiable', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'boolean-body-'));
 try {
  const path = join(dir, 'spec.json');
  await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Boolean', version: '1' }, paths: { '/items': { post: { operationId: 'items', requestBody: { required: true, content: { 'application/json': { schema: false } } }, responses: { '204': { description: 'ok' } } } } } }));
  const doc = await loadSpec(path); await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  console.log(JSON.stringify(tool.inputSchema));
  const validate = compileOutputValidator(tool.inputSchema);
  assert.equal(validate({ body: {} }), false);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mock API receives a body forbidden by false schema', async () => {
 const { createServer } = await import('node:http');
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
 const dir = await mkdtemp(join(tmpdir(), 'boolean-wire-'));
 let seen = 0;
 const api = createServer((req, res) => { req.resume(); req.on('end', () => { seen++; res.writeHead(204); res.end(); }); });
 await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
 const address = api.address() as { port: number };
 let server: any; let client: any;
 try {
  const path = join(dir, 'spec.json');
  await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Boolean', version: '1' }, paths: { '/items': { post: { operationId: 'items', requestBody: { required: true, content: { 'application/json': { schema: false } } }, responses: { '204': { description: 'ok' } } } } } }));
  const doc = await loadSpec(path); await init(doc);
  server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${address.port}` }), { port: 0 });
  client = new Client({ name: 'boolean-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await client.callTool({ name: 'items', arguments: { body: {} } });
  console.log('mock hits', seen, 'isError', result.isError);
  assert.equal(seen, 0, 'false schema should reject before sending');
 } finally {
  await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
  api.closeAllConnections(); await new Promise<void>(r => api.close(() => r())); await rm(dir, { recursive: true, force: true });
 }
});

for (const version of ['3.1.0', '3.1.1']) for (const contentType of ['application/json', 'application/vnd.test+json']) for (const required of [false, true]) for (const value of [false, true]) for (const reference of [false, true]) {
 test(`${version} ${contentType} required=${required} boolean=${value} ref=${reference}`, async () => {
  const doc: any = { openapi: version, info: { title: 'Boolean sweep', version: '1' }, components: { schemas: { Boolean: value } }, paths: { '/': { post: {
   operationId: 'post', requestBody: { required, content: { [contentType]: { schema: reference ? { $ref: '#/components/schemas/Boolean' } : value } } }, responses: { '204': { description: 'ok' } },
  } } } };
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.equal(tool.args[0]!.name, 'body');
  assert.deepEqual(tool.args[0]!.apiFieldPath, []);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  assert.equal(validate({}), !required);
  for (const body of [{}, [], 'text', 3, true, false, null]) assert.equal(validate({ body }), value);
 });
}
