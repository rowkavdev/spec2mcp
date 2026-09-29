/**
 * End-to-end for multipart uploads and non-JSON responses: generate a server
 * from the media fixture, boot it over stdio, and drive a real MCP session
 * against a mock HTTP API that records what it receives and serves image,
 * PDF and large CSV payloads.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

const MEDIA = fileURLToPath(new URL('./fixtures/media.yaml', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
// Scratch dir inside the repo so the generated server.mjs resolves
// @modelcontextprotocol/sdk from this repo's node_modules.
const OUT = fileURLToPath(new URL('../.tmp-e2e-media/', import.meta.url));

function join(a: string, b: string): string {
  return `${a.replace(/\/+$/, '')}/${b}`;
}

// Small synthetic payloads - the mock echoes bytes, nothing parses them.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-pixels')]);
const PDF_BYTES = Buffer.from('%PDF-1.4 fake pdf body\n%%EOF');
const BIG_PNG_BYTES = Buffer.alloc(6000, 0x41); // over the test's 4096-byte binary cap
const CSV_TEXT = `id,name\n${Array.from({ length: 4000 }, (_, i) => `${i},pet-${i}`).join('\n')}`;

type SeenRequest = { method: string; url: string; headers: Record<string, unknown>; body: Buffer };
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

function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return rpc('tools/call', { name, arguments: args }).then((res) => res.result as Record<string, unknown>);
}

before(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/media/pets/7/photo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.method === 'GET' && url === '/media/pets/7/photo') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_BYTES);
      } else if (req.method === 'GET' && url === '/media/pets/999/photo') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(BIG_PNG_BYTES);
      } else if (req.method === 'GET' && url === '/media/pets/7/records') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(PDF_BYTES);
      } else if (req.method === 'GET' && url === '/media/export') {
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end(CSV_TEXT);
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}/media`;

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const doc = await loadSpec(MEDIA);
  await init(doc);
  const manifest = buildManifest(doc, { baseUrl: apiBase });
  await writeFile(join(OUT, 'operations.json'), JSON.stringify(manifest, null, 2));
  await copyFile(RUNTIME, join(OUT, 'server.mjs'));

  child = spawn(process.execPath, [join(OUT, 'server.mjs')], {
    env: {
      ...process.env,
      // Small caps so the truncation tests do not need giant payloads.
      SPEC2MCP_MAX_RESPONSE_CHARS: '10000',
      SPEC2MCP_MAX_BINARY_BYTES: '4096',
    },
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
    clientInfo: { name: 'spec2mcp-e2e-media', version: '0.0.0' },
  });
  assert.ok((initRes.result as Record<string, unknown>)?.serverInfo);
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(async () => {
  child?.kill('SIGKILL');
  api?.close();
  await rm(OUT, { recursive: true, force: true });
});

test('tools/list exposes the media operations with a file argument schema', async () => {
  const res = await rpc('tools/list');
  const tools = (res.result as Record<string, unknown>).tools as { name: string; inputSchema: Record<string, unknown> }[];
  assert.equal(tools.length, 4);
  const upload = tools.find((t) => t.name === 'upload_pet_photo');
  assert.ok(upload);
  assert.deepEqual(upload.inputSchema.required, ['petId', 'photo']);
  const photo = (upload.inputSchema.properties as Record<string, Record<string, unknown>>).photo;
  assert.ok(photo);
  assert.equal(photo.type, 'object');
  assert.deepEqual(photo.required, ['contentBase64']);
});

test('tools/call encodes a real multipart/form-data request', async () => {
  seen.length = 0;
  const result = await callTool('upload_pet_photo', {
    petId: 7,
    photo: { contentBase64: Buffer.from('FAKEPNGBYTES').toString('base64'), filename: 'rex.png', mimeType: 'image/png' },
    caption: 'Good boy',
    isPublic: true,
    labels: ['dog', 'rex'],
    metadata: { shots: 2 },
  });
  assert.notEqual(result.isError, true);
  assert.equal(seen.length, 1);
  const req = seen[0]!;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/media/pets/7/photo');
  const contentType = String(req.headers['content-type']);
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const body = req.body.toString('utf8');
  assert.match(body, /name="photo"; filename="rex\.png"/);
  assert.match(body, /content-type: image\/png/i);
  assert.ok(body.includes('FAKEPNGBYTES'), 'file bytes travel verbatim');
  assert.match(body, /name="caption"\r\n\r\nGood boy/);
  assert.match(body, /name="isPublic"\r\n\r\ntrue/);
  assert.match(body, /name="labels"\r\n\r\n\["dog","rex"\]/, 'array fields are JSON-serialised');
  assert.match(body, /name="metadata"\r\n\r\n\{"shots":2\}/, 'object fields are JSON-serialised');
});

test('file arguments default their filename to the field name', async () => {
  seen.length = 0;
  const result = await callTool('upload_pet_photo', {
    petId: 7,
    photo: { contentBase64: Buffer.from('FAKEPNGBYTES').toString('base64') },
  });
  assert.notEqual(result.isError, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.body.toString('utf8'), /name="photo"; filename="photo"/);
});

test('a malformed file argument fails before any request is made', async () => {
  seen.length = 0;
  const result = await callTool('upload_pet_photo', { petId: 7, photo: 'not-an-object' });
  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0]!.text, /contentBase64/);
  assert.equal(seen.length, 0);
});

test('a missing required file argument fails before any request is made', async () => {
  seen.length = 0;
  const result = await callTool('upload_pet_photo', { petId: 7 });
  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0]!.text, /photo/);
  assert.equal(seen.length, 0);
});
