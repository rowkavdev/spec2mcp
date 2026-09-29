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

const OUT = fileURLToPath(new URL('../.tmp-required-body/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const doc = {
  openapi: '3.0.3', info: { title: 'Coverage', version: '1' }, components: { schemas: {} },
  paths: { '/pets': { post: {
    operationId: 'createPet', parameters: [{ name: 'pet', in: 'query', schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/json': {
      schema: { type: 'object', required: ['pet'], properties: {
        pet: { type: 'object', nullable: true, properties: { id: { type: 'string' } } },
      } },
    } } }, responses: { '201': { description: 'Created' } },
  } } },
} as unknown as OpenAPIV3.Document;
let api: HttpServer;
let child: ChildProcess;
let buffer = '';
let nextId = 1;
const pending = new Map<number, (message: any) => void>();
const seen: { url: string; body: string }[] = [];
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
      seen.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(201, { 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  await init(doc);
  const manifest = buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
  const args = manifest.tools[0]!.args;
  assert.ok(args.find((arg) => arg.name === 'pet' && arg.location === 'query'));
  assert.ok(args.find((arg) => arg.name === 'pet.id' && arg.location === 'body'));
  assert.ok(args.find((arg) => arg.name === 'pet_body' && arg.location === 'body' && arg.required));
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/operations.json`, JSON.stringify(manifest));
  await copyFile(RUNTIME, `${OUT}/server.mjs`);
  child = spawn(process.execPath, [`${OUT}/server.mjs`], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout!.on('data', (chunk) => {
    buffer += chunk.toString(); let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    }
  });
  child.stderr!.on('data', () => {});
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'coverage-test', version: '1' } });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});
after(async () => { child?.kill('SIGKILL'); api?.close(); await rm(OUT, { recursive: true, force: true }); });

test('#123 query pet does not cover required body pet', async () => {
  const result = await rpc('tools/call', { name: 'create_pet', arguments: { pet: 'query-only' } });
  assert.equal(result.error, undefined);
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Missing required argument.*pet_body/);
  assert.equal(seen.length, 0);
});
test('#123 body pet.id covers required body parent pet', async () => {
  const result = await rpc('tools/call', { name: 'create_pet', arguments: { pet: 'query-value', 'pet.id': 'leaf-value' } });
  assert.equal(result.error, undefined);
  assert.notEqual(result.result.isError, true);
  assert.equal(seen.at(-1)?.body, '{"pet":{"id":"leaf-value"}}');
  assert.equal(new URL(seen.at(-1)!.url, 'http://localhost').searchParams.get('pet'), 'query-value');
});
