/**
 * End-to-end: generate a server from the fixture, boot it over stdio, and
 * drive a real MCP session (initialize -> tools/list -> tools/call) against
 * a mock HTTP API that records what it receives.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
// Scratch dir inside the repo so the generated server.mjs resolves
// @modelcontextprotocol/sdk from this repo's node_modules.
const OUT = fileURLToPath(new URL('../.tmp-e2e/', import.meta.url));

type SeenRequest = { method: string; url: string; headers: Record<string, unknown>; body: string };
const seen: SeenRequest[] = [];
let api: HttpServer;
let apiBase: string;
let child: ChildProcess;
let buffer = '';
const pending = new Map<number, (msg: Record<string, unknown>) => void>();
let nextId = 1;

function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

before(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`;

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const doc = await loadSpec(PETSTORE);
  doc.paths['/pets']!.get!.security = [];
  doc.paths['/pets']!.post!.security = [{ apiKeyQuery: [] }];
  doc.paths['/uploads']!.post!.security = [{ bearerAuth: [], apiKeyQuery: [] }];
  await init(doc);
  const manifest = buildManifest(doc, { baseUrl: apiBase });
  await writeFile(join(OUT, 'operations.json'), JSON.stringify(manifest, null, 2));
  await copyFile(RUNTIME, join(OUT, 'server.mjs'));

  child = spawn(process.execPath, [join(OUT, 'server.mjs')], {
    env: { ...process.env, PET_STORE_BEARER_AUTH: 'test-token-123', PET_STORE_API_KEY_QUERY: 'query-token-456' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr!.on('data', () => {});

  const initRes = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spec2mcp-e2e', version: '0.0.0' },
  });
  assert.ok((initRes.result as Record<string, unknown>)?.serverInfo);
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(async () => {
  child?.kill('SIGKILL');
  api?.close();
  await rm(OUT, { recursive: true, force: true });
});

function join(a: string, b: string): string {
  return `${a.replace(/\/+$/, '')}/${b}`;
}

test('tools/list returns every operation', async () => {
  const res = await rpc('tools/list');
  const tools = (res.result as Record<string, unknown>).tools as { name: string }[];
  assert.equal(tools.length, 7);
  assert.ok(tools.some((t) => t.name === 'get_pet'));
});

test('tools/call substitutes path params and sends bearer auth', async () => {
  seen.length = 0;
  const res = await rpc('tools/call', { name: 'get_pet', arguments: { petId: 42 } });
  const content = (res.result as Record<string, unknown>).content as { text: string }[];
  assert.match(content[0]!.text, /"ok": true/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, 'GET');
  assert.equal(seen[0]!.url, '/v1/pets/42');
  assert.equal(seen[0]!.headers.authorization, 'Bearer test-token-123');
});

test('tools/call maps query params including arrays', async () => {
  seen.length = 0;
  await rpc('tools/call', { name: 'list_pets', arguments: { limit: 5, tags: ['cat', 'dog'] } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, '/v1/pets?limit=5&tags=cat&tags=dog');
  assert.equal(seen[0]!.headers.authorization, undefined, 'explicit anonymous operation sends no root auth');
});

test('tools/call reconstructs nested JSON bodies', async () => {
  seen.length = 0;
  await rpc('tools/call', {
    name: 'create_pet',
    arguments: { name: 'Rex', 'address.street': '1 Main St', 'address.city': 'London' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.url, '/v1/pets?api_key=query-token-456');
  assert.equal(seen[0]!.headers.authorization, undefined, 'operation override excludes root bearer');
  assert.match(seen[0]!.headers['content-type'] as string, /application\/json/);
  assert.deepEqual(JSON.parse(seen[0]!.body), { name: 'Rex', address: { street: '1 Main St', city: 'London' } });
});

test('tools/call combines AND security schemes for one operation', async () => {
  seen.length = 0;
  await rpc('tools/call', { name: 'upload_file', arguments: { body: 'test' } });
  assert.equal(seen[0]!.url, '/v1/uploads?api_key=query-token-456');
  assert.equal(seen[0]!.headers.authorization, 'Bearer test-token-123');
});

test('missing required arg returns a tool error without calling the API', async () => {
  seen.length = 0;
  const res = await rpc('tools/call', { name: 'create_pet', arguments: {} });
  const result = res.result as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0]!.text, /name/);
  assert.equal(seen.length, 0);
});

test('unknown tool returns a tool error', async () => {
  const res = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal((res.result as Record<string, unknown>).isError, true);
});
