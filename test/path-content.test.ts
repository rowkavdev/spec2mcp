import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

const OUT = fileURLToPath(new URL('../.tmp-path-content/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const doc = {
  openapi: '3.0.3', info: { title: 'Path content', version: '1' }, components: { schemas: {} },
  paths: { '/items/{filter}': { get: { operationId: 'getItems', parameters: [{ name: 'filter', in: 'path', required: true, content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } } }], responses: { '200': { description: 'OK' } } } } },
} as unknown as OpenAPIV3.Document;
let api: HttpServer;
let child: ChildProcess;
let buffer = '';
let nextId = 1;
const pending = new Map<number, (message: any) => void>();
const seen: { url: string; headers: Record<string, unknown>; body: string }[] = [];
function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (message) => { clearTimeout(timeout); resolve(message); });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

before(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const paths = doc.paths as any;
  for (const [operationId, mediaType, schema] of [
    ['textValue', 'application/json', { type: 'string' }],
    ['arrayValue', 'application/problem+json', { type: 'array', items: { type: 'integer' } }],
    ['plainValue', 'text/plain', { type: 'string' }],
  ] as const) {
    paths[`/${operationId}/{value}`] = { get: { operationId,
      parameters: [{ name: 'value', in: 'path', required: true, content: { [mediaType]: { schema } } }],
      responses: { '200': { description: 'OK' } },
    } };
  }
  await init(doc);
  const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const manifest = buildManifest(doc, { baseUrl });
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/operations.json`, JSON.stringify(manifest));
  await copyFile(RUNTIME, `${OUT}/server.mjs`);
  child = spawn(process.execPath, [`${OUT}/server.mjs`], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout!.on('data', (chunk) => {
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    }
  });
  child.stderr!.on('data', () => {});
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'path-content-test', version: '1' } });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});
after(async () => { child?.kill('SIGKILL'); api?.close(); await rm(OUT, { recursive: true, force: true }); });

test('JSON path content keeps its media type and sends one encoded JSON path value', async () => {
  const tool = buildManifest(doc).tools[0]!;
  assert.equal(tool.args[0]!.parameterContentType, 'application/json');
  const schema = (tool.inputSchema.properties as Record<string, unknown>).filter as any;
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.id.type, 'integer');
  const result = await rpc('tools/call', { name: 'get_items', arguments: { filter: { id: 1 } } });
  assert.notEqual(result.result.isError, true, JSON.stringify(result));
  assert.equal(seen[0]!.url, '/items/%7B%22id%22%3A1%7D');
});

test('JSON path content rejects invalid values before contacting the API', async () => {
  const before = seen.length;
  const result = await rpc('tools/call', { name: 'get_items', arguments: { filter: { id: 'bad' } } });
  assert.ok(result.error || result.result?.isError, JSON.stringify(result));
  assert.equal(seen.length, before);
});

test('JSON strings and arrays are JSON-encoded rather than style-serialized', async () => {
  for (const [name, value, expected] of [
    ['text_value', 'a/b', '/textValue/%22a%2Fb%22'],
    ['array_value', [1, 2], '/arrayValue/%5B1%2C2%5D'],
  ] as const) {
    const result = await rpc('tools/call', { name, arguments: { value } });
    assert.notEqual(result.result?.isError, true, JSON.stringify(result));
    assert.equal(seen.at(-1)!.url, expected);
  }
});

test('unsupported path content is rejected without an upstream request', async () => {
  const before = seen.length;
  const result = await rpc('tools/call', { name: 'plain_value', arguments: { value: 'abc' } });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Unsupported path content media type "text\/plain"/);
  assert.equal(seen.length, before);
});
