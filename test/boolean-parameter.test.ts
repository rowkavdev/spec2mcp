import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
for (const location of ['query', 'header', 'cookie']) test(`false ${location} parameter rejects a supplied value`, async () => {
 const doc: any = { openapi: '3.1.0', info: { title: 'Boolean parameter', version: '1' }, components: { schemas: {} }, paths: { '/': { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, schema: false }], responses: { '204': { description: 'ok' } } } } } };
 await init(doc);
 const tool = buildManifest(doc).tools[0]!;
 console.log(location, JSON.stringify(tool.inputSchema), JSON.stringify(tool.args));
 const validate = compileOutputValidator(tool.inputSchema);
 assert.equal(validate({ filter: 'value' }), false);
});
test('false query schema rejects before mock API receives parameter', async () => {
 const { createServer } = await import('node:http');
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
 const seen: string[] = [];
 const api = createServer((req, res) => { seen.push(req.url!); res.writeHead(204); res.end(); });
 await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
 const doc: any = { openapi: '3.1.0', info: { title: 'Boolean parameter', version: '1' }, components: { schemas: {} }, paths: { '/': { get: { operationId: 'get', parameters: [{ name: 'filter', in: 'query', schema: false }], responses: { '204': { description: 'ok' } } } } } };
 let server: any; let client: any;
 try {
  await init(doc); server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as any).port}` }), { port: 0 });
  client = new Client({ name: 'boolean-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await client.callTool({ name: 'get', arguments: { filter: 'value' } });
  console.log('mock urls', seen, 'isError', result.isError);
  assert.equal(seen.length, 0);
 } finally {
  await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
  api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
 }
});

for (const version of ['3.1.0', '3.1.1']) for (const location of ['path', 'query', 'header', 'cookie']) for (const required of [false, true]) for (const value of [false, true]) for (const reference of [false, true]) for (const content of [false, true]) {
 test(`${version} ${location} required=${required} boolean=${value} ref=${reference} content=${content}`, async () => {
  const schema = reference ? { $ref: '#/components/schemas/Boolean' } : value;
  const doc: any = { openapi: version, info: { title: 'Boolean parameters', version: '1' }, components: { schemas: { Boolean: value } }, paths: {
   [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, required, ...(content ? { content: { 'application/json': { schema } } } : { schema }) }], responses: { '204': { description: 'ok' } } } },
  } };
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  assert.equal(validate({}), location !== 'path' && !required);
  for (const filter of ['value', 2, true, null, [], {}]) assert.equal(validate({ filter }), value);
 });
}

for (const version of ['3.1.0', '3.1.1']) for (const location of ['path', 'query', 'header', 'cookie']) for (const value of [false, true]) for (const chain of [false, true]) for (const content of [false, true]) {
 test(`${version} ${location} boolean=${value} chain=${chain} content=${content} preserves ref intersections and annotations`, async () => {
  const schema = { $ref: chain ? '#/components/schemas/Hop' : '#/components/schemas/Boolean', type: 'integer', minimum: 2, description: 'Schema note' };
  const doc: any = { openapi: version, info: { title: 'Boolean siblings', version: '1' }, components: { schemas: {
   Boolean: value, Hop: { $ref: '#/components/schemas/Boolean', maximum: 5, description: 'Hop note' },
  } }, paths: { [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location,
   description: 'Important meaning', ...(content ? { content: { 'application/json': { schema } } } : { schema }),
  }], responses: { '204': { description: 'ok' } } } } } };
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  const mapped = tool.args[0]!.schema;
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  assert.equal(validate({ filter: 3 }), value);
  for (const filter of [1, 'string', 2.5]) assert.equal(validate({ filter }), false);
  assert.equal(validate({ filter: 6 }), value && !chain);
  assert.ok(JSON.stringify(mapped).includes('Schema note'));
  if (chain) assert.ok(JSON.stringify(mapped).includes('Hop note'));
  if (!content) assert.equal(mapped.description, 'Important meaning');
 });
}
for (const location of ['path', 'query', 'header', 'cookie']) for (const value of [false, true]) {
 test(`${location} direct boolean=${value} retains parameter description without adding a type`, async () => {
  const doc: any = { openapi: '3.1.0', info: { title: 'Boolean annotations', version: '1' }, components: { schemas: {} }, paths: {
   [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, description: 'Important meaning', schema: value }], responses: { '204': { description: 'ok' } } } },
  } };
  await init(doc);
  const mapped = buildManifest(doc).tools[0]!.args[0]!.schema;
  assert.equal(mapped.description, 'Important meaning');
  assert.equal(mapped.type, undefined);
 });
}

for (const version of ['3.0.3', '3.1.0', '3.1.1']) for (const location of ['query', 'header', 'cookie']) {
 test(`${version} ${location} ordinary schema metadata is unchanged`, async () => {
  const doc: any = { openapi: version, info: { title: 'Ordinary metadata', version: '1' }, components: { schemas: { Score: { type: 'integer', minimum: 2, enum: [2, 3], default: 2, description: 'Target note' } } }, paths: {
   '/': { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, description: 'Important meaning', schema: { $ref: '#/components/schemas/Score' } }], responses: { '204': { description: 'ok' } } } },
  } };
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.equal(tool.args[0]!.schema.type, 'integer');
  assert.equal(tool.args[0]!.schema.default, 2);
  assert.equal(tool.args[0]!.schema.description, 'Important meaning');
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  assert.equal(validate({ filter: 2 }), true);
  assert.equal(validate({ filter: 1 }), false);
  assert.equal(validate({ filter: 4 }), false);
 });
}
for (const location of ['path', 'query', 'header', 'cookie']) for (const content of [false, true]) for (const value of [false, true]) {
 test(`${location} content=${content} boolean=${value} validates before HTTP and keeps serializer guards`, async () => {
  const { createServer } = await import('node:http');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
  const seen: { url: string; headers: any }[] = [];
  const api = createServer((req, res) => { seen.push({ url: req.url!, headers: req.headers }); res.writeHead(204); res.end(); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const doc: any = { openapi: '3.1.1', info: { title: 'Boolean wire controls', version: '1' }, components: { schemas: { Boolean: value } }, paths: {
   [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, required: true,
    ...(content ? { content: { 'application/json': { schema: { $ref: '#/components/schemas/Boolean' } } } } : { schema: value }),
   }], responses: { '204': { description: 'ok' } } } },
  } };
  let server: any; let client: any;
  try {
   await init(doc);
   server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as any).port}` }), { port: 0 });
   client = new Client({ name: 'boolean-wire-test', version: '1' });
   await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
   const missing = await client.callTool({ name: 'get', arguments: {} });
   assert.equal(missing.isError, true);
   assert.equal(seen.length, 0);
   const result = await client.callTool({ name: 'get', arguments: { filter: 3 } });
   assert.equal(result.isError, value ? undefined : true);
   assert.equal(seen.length, value ? 1 : 0);
   if (value) {
    if (location === 'path') assert.equal(seen[0]!.url, '/3');
    if (location === 'query') assert.equal(seen[0]!.url, '/?filter=3');
    if (location === 'header') assert.equal(seen[0]!.headers.filter, '3');
    if (location === 'cookie') assert.equal(seen[0]!.headers.cookie, 'filter=3');
   }
   const before = seen.length;
   const nested = await client.callTool({ name: 'get', arguments: { filter: { child: { id: 2 } } } });
   assert.equal(nested.isError, value && content ? undefined : true);
   assert.equal(seen.length, before + (value && content ? 1 : 0));
  } finally {
   await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
   api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
  }
 });
}

for (const location of ['path', 'query', 'header', 'cookie']) {
 test(`${location} boolean ref schema description remains visible without parameter annotation`, async () => {
  const doc: any = { openapi: '3.1.0', info: { title: 'Schema note', version: '1' }, components: { schemas: { Boolean: true } }, paths: {
   [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, schema: { $ref: '#/components/schemas/Boolean', description: 'Schema note' } }], responses: { '204': { description: 'ok' } } } },
  } };
  await init(doc);
  const mapped = buildManifest(doc).tools[0]!.args[0]!.schema;
  assert.equal(mapped.description, 'Schema note');
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
  assert.equal(validate({ filter: { arbitrary: true } }), true);
 });
}
for (const location of ['path', 'query', 'header', 'cookie']) {
 test(`${location} false terminal stays false if sibling mapping exceeds budget`, async () => {
  const doc: any = { openapi: '3.1.0', info: { title: 'False fallback', version: '1' }, components: { schemas: { Boolean: false } }, paths: {
   [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, schema: { $ref: '#/components/schemas/Boolean', const: 'x'.repeat(300000) } }], responses: { '204': { description: 'ok' } } } },
  } };
  await init(doc);
  const manifest = buildManifest(doc);
  assert.ok(manifest.warnings?.some(warning => warning.includes('boolean schema constraints omitted')));
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
  assert.equal(validate({ filter: 'value' }), false);
 });
}

for (const location of ['path', 'query', 'header', 'cookie']) for (const value of [false, true]) {
 test(`3.0.3 ${location} ref boolean=${value} keeps legacy string mapping and descriptions`, async () => {
  const doc: any = { openapi: '3.0.3', info: { title: 'Legacy boolean control', version: '1' }, components: { schemas: { Boolean: value } }, paths: {
   [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, description: 'Important meaning', schema: { $ref: '#/components/schemas/Boolean', minimum: 2, description: 'Schema note' } }], responses: { '204': { description: 'ok' } } } },
  } };
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.equal(tool.args[0]!.schema.description, 'Important meaning');
  assert.equal(tool.args[0]!.schema.type, 'string');
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  assert.equal(validate({ filter: 'value' }), true);
  assert.equal(validate({ filter: 3 }), false);
 });
}

for (const location of ['path', 'query', 'header', 'cookie']) {
 test(`${location} content false terminal remains rejecting on oversized annotation fallback`, async () => {
  const doc: any = { openapi: '3.1.0', info: { title: 'Content false fallback', version: '1' }, components: { schemas: { Boolean: false } }, paths: {
   [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, content: { 'application/json': { schema: { $ref: '#/components/schemas/Boolean', description: 'x'.repeat(100000) } } } }], responses: { '204': { description: 'ok' } } } },
  } };
  await init(doc);
  const manifest = buildManifest(doc);
  assert.ok(manifest.warnings?.some(warning => warning.includes('schema constraints omitted')));
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
  assert.equal(validate({ filter: 'value' }), false);
 });
}
for (const location of ['path', 'query', 'header', 'cookie']) for (const content of [false, true]) for (const hops of [12, 13, 15]) for (const value of [false, true]) {
 test(`${location} content=${content} boolean=${value} chain boundary ${hops} retains terminal meaning`, async () => {
  const schemas: Record<string, any> = { Boolean: value };
  for (let i = hops - 1; i >= 1; i--) schemas[`Hop${i}`] = { $ref: i === hops - 1 ? '#/components/schemas/Boolean' : `#/components/schemas/Hop${i + 1}` };
  const schema = { $ref: '#/components/schemas/Hop1' };
  const doc: any = { openapi: '3.1.0', info: { title: 'Boolean depth controls', version: '1' }, components: { schemas }, paths: {
   [location === 'path' ? '/{filter}' : '/']: { get: { operationId: 'get', parameters: [{ name: 'filter', in: location, ...(content ? { content: { 'application/json': { schema } } } : { schema }) }], responses: { '204': { description: 'ok' } } } },
  } };
  await init(doc);
  const manifest = buildManifest(doc);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
  for (const filter of ['value', 3, { arbitrary: true }]) assert.equal(validate({ filter }), value);
 });
}
