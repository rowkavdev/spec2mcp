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
      const url = req.url ?? '';
      const isList = req.method === 'GET' && (url === '/v1/pets' || url.startsWith('/v1/pets?'));
      // Pet-shaped for get_pet so its structuredContent validates; the
      // { ok: true } fallback elsewhere doubles as a drifted body for
      // create_pet, whose outputSchema declares a Pet.
      const petMatch = req.method === 'GET' ? /^\/v1\/pets\/(\d+)$/.exec(url) : null;
      res.end(JSON.stringify(isList ? [{ id: 1, name: 'Rex' }] : petMatch ? { id: Number(petMatch[1]), name: 'Rex' } : { ok: true }));
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
  assert.match(content[0]!.text, /"name": "Rex"/);
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

test('tools/list advertises outputSchema only where the spec declares one', async () => {
  const res = await rpc('tools/list');
  const tools = (res.result as Record<string, unknown>).tools as { name: string; outputSchema?: Record<string, unknown> }[];
  const getPet = tools.find((t) => t.name === 'get_pet');
  assert.equal(getPet?.outputSchema?.type, 'object');
  const legacy = tools.find((t) => t.name === 'get_legacy');
  assert.equal(legacy?.outputSchema, undefined);
});

test('tools/call returns structuredContent for an object response', async () => {
  const res = await rpc('tools/call', { name: 'get_pet', arguments: { petId: 7 } });
  const result = res.result as Record<string, unknown>;
  assert.deepEqual(result.structuredContent, { id: 7, name: 'Rex' });
  const content = result.content as { type: string; text: string }[];
  assert.match(content[0]!.text, /"id": 7/, 'text content kept alongside structuredContent');
});

test('tools/call returns a tool error when the response drifts from the outputSchema', async () => {
  // The mock answers POST /pets with { ok: true }, which is not Pet-shaped:
  // the runtime must not attach structuredContent the SDK client would reject.
  const res = await rpc('tools/call', { name: 'create_pet', arguments: { name: 'Rex' } });
  const result = res.result as Record<string, unknown>;
  assert.equal(result.isError, true, 'drift must be a tool error');
  assert.equal(result.structuredContent, undefined, 'drifted response is not attached');
  const content = result.content as { type: string; text: string }[];
  assert.match(content[0]!.text, /"ok": true/, 'text content survives the fallback');
  assert.match(content[1]!.text, /outputSchema fallback/);
});

test('tools/call wraps an array response under result', async () => {
  const res = await rpc('tools/call', { name: 'list_pets', arguments: {} });
  const result = res.result as Record<string, unknown>;
  assert.deepEqual(result.structuredContent, { result: [{ id: 1, name: 'Rex' }] });
});

test('tools/call without an outputSchema stays text-only', async () => {
  const res = await rpc('tools/call', { name: 'get_legacy', arguments: {} });
  const result = res.result as Record<string, unknown>;
  assert.equal(result.structuredContent, undefined);
  const content = result.content as { type: string; text: string }[];
  assert.match(content[0]!.text, /"ok": true/);
});

test('generated runtime reads project config to narrow tools and override server name/base URL', async () => {
  child.kill('SIGKILL');
  await writeFile(join(OUT, 'spec2mcp.config.json'), JSON.stringify({
    name: 'petstore-curated', baseUrl: apiBase, include: ['operation:getPet'], exclude: [],
  }));
  child = spawn(process.execPath, [join(OUT, 'server.mjs')], {
    env: { ...process.env, PET_STORE_BEARER_AUTH: 'test-token-123' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  buffer = '';
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
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'config-e2e', version: '0.0.0' },
  });
  assert.equal((initRes.result as { serverInfo: { name: string } }).serverInfo.name, 'petstore-curated');
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await rpc('tools/list');
  assert.deepEqual(((listed.result as { tools: { name: string }[] }).tools).map((tool) => tool.name), ['get_pet']);
  seen.length = 0;
  await rpc('tools/call', { name: 'get_pet', arguments: { petId: 9 } });
  assert.equal(seen[0]?.url, '/v1/pets/9');
});
