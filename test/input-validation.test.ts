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

const OUT = fileURLToPath(new URL('../.tmp-input-validation/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const doc = {
  openapi: '3.0.3', info: { title: 'Query content', version: '1' }, components: { schemas: {} },
  paths: { '/items': { get: { operationId: 'getItems', parameters: [{ name: 'filter', in: 'query', required: true, content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } } }], responses: { '200': { description: 'OK' } } } } },
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

test('invalid JSON query content is rejected before upstream HTTP', async () => {
  for (const filter of [{ id: 'bad' }, { id: 1.5 }, { id: 1, extra: true }, {}]) {
    const result = await rpc('tools/call', { name: 'get_items', arguments: { filter } });
    assert.equal(result.result?.isError, true, JSON.stringify(result));
    assert.equal(seen.length, 0);
  }
  const result = await rpc('tools/call', { name: 'get_items', arguments: { filter: { id: 1 } } });
  assert.notEqual(result.result.isError, true, JSON.stringify(result));
  assert.equal(seen.length, 1);
});
