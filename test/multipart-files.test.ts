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

const OUT = fileURLToPath(new URL('../.tmp-multipart-files/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const doc = {
  openapi: '3.0.3', info: { title: 'Files', version: '1' }, components: { schemas: {} },
  paths: { '/photos': { post: { operationId: 'uploadPhotos', requestBody: { required: true, content: { 'multipart/form-data': {
    schema: { type: 'object', required: ['photos'], properties: { photos: { type: 'array', items: { type: 'string', format: 'binary' } }, tags: { type: 'array', items: { type: 'string' } } } },
    encoding: { photos: { contentType: 'text/plain' } },
  } } }, responses: { '200': { description: 'OK' } } } } },
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

test('#145 binary arrays are file objects and send separate same-name parts', async () => {
  const photos = buildManifest(doc).tools[0]!.args.find(arg => arg.name === 'photos')!;
  assert.equal((photos.schema.items as any).properties.contentBase64.type, 'string');
  const result = await rpc('tools/call', { name: 'upload_photos', arguments: { photos: [{ contentBase64: 'YQ==', filename: 'a.txt' }, { contentBase64: 'Yg==', filename: 'b.txt' }], tags: ['x', 'y'] } });
  assert.notEqual(result.result.isError, true, JSON.stringify(result));
  assert.equal((seen[0]!.body.match(/name="photos"; filename=/g) ?? []).length, 2);
  assert.match(seen[0]!.body, /filename="a.txt"\r\nContent-Type: text\/plain\r\n\r\na\r\n/);
  assert.match(seen[0]!.body, /filename="b.txt"\r\nContent-Type: text\/plain\r\n\r\nb\r\n/);
  assert.match(seen[0]!.body, /name="tags"\r\n\r\n\["x","y"\]\r\n/);
  const count = seen.length;
  const bad = await rpc('tools/call', { name: 'upload_photos', arguments: { photos: [{ contentBase64: 'bad===' }] } });
  assert.equal(bad.result.isError, true); assert.equal(seen.length, count);
});
