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

const OUT = fileURLToPath(new URL('../.tmp-multipart-collision/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const doc = {
  openapi: '3.0.3', info: { title: 'Collision', version: '1' }, components: { schemas: {} },
  paths: { '/upload': { post: {
    operationId: 'upload',
    parameters: [
      { name: 'file', in: 'query', schema: { type: 'string' } },
      { name: 'caption', in: 'header', schema: { type: 'string' } },
    ],
    requestBody: { required: true, content: { 'multipart/form-data': { schema: {
      type: 'object', required: ['file'], properties: {
        file: { type: 'string', format: 'binary' }, caption: { type: 'string' },
      },
    } } } },
    responses: { '200': { description: 'OK' } },
  } } },
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

test('#91 manifest keeps original wire names on multipart file and scalar args', async () => {
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.deepEqual(tool.args.map(({ name, apiName, location }) => ({ name, apiName, location })), [
    { name: 'file', apiName: undefined, location: 'query' },
    { name: 'caption', apiName: undefined, location: 'header' },
    { name: 'file_body', apiName: 'file', location: 'body' },
    { name: 'caption_body', apiName: 'caption', location: 'body' },
  ]);
});

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
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'multipart-collision-test', version: '1' } });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});
after(async () => { child?.kill('SIGKILL'); api?.close(); await rm(OUT, { recursive: true, force: true }); });

test('#91 multipart collision uses original API names and filename on the wire', async () => {
  const result = await rpc('tools/call', { name: 'upload', arguments: {
    file: 'query-value', caption: 'header-value',
    file_body: { contentBase64: Buffer.from('hello').toString('base64') }, caption_body: 'form-value',
  } });
  assert.equal(result.error, undefined);
  assert.notEqual(result.result.isError, true);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0]!.url, 'http://localhost').searchParams.get('file'), 'query-value');
  assert.equal(seen[0]!.headers.caption, 'header-value');
  assert.match(seen[0]!.body, /name="file"; filename="file"/);
  assert.match(seen[0]!.body, /name="file"; filename="file"[\s\S]*?\r\n\r\nhello\r\n/);
  assert.match(seen[0]!.body, /name="caption"\r\n\r\nform-value\r\n/);
  assert.doesNotMatch(seen[0]!.body, /name="file_body"|name="caption_body"/);
});
