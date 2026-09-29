/**
 * Regression tests for the verified runtime bug batch (#36-#41): generate a
 * server from the runtime-fixes fixture, boot it over stdio, and drive real
 * MCP tool calls against a mock HTTP API that records requests and serves
 * malformed, aborted and oversized responses.
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

const FIXTURE = fileURLToPath(new URL('./fixtures/runtime-fixes.yaml', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const OUT = fileURLToPath(new URL('../.tmp-e2e-runtime-fixes/', import.meta.url));

const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

type SeenRequest = { method: string; url: string; body: Buffer };
const seen = new Map<string, SeenRequest[]>();
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

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
const callTool = (name: string, args: Record<string, unknown>) =>
  rpc('tools/call', { name, arguments: args }).then((res) => res.result as ToolResult);

before(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const key = `${req.method} ${url.split('?')[0]}`;
      const list = seen.get(key) ?? [];
      list.push({ method: req.method ?? '', url, body: Buffer.concat(chunks) });
      seen.set(key, list);
      if (url.startsWith('/data')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{not valid json');
      } else if (url.startsWith('/big')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: 'x'.repeat(5000) }));
      } else if (url.startsWith('/abort')) {
        // Deliver headers and a partial chunked body, then cut the
        // connection: fetch resolves the response and arrayBuffer() rejects.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial":');
        res.flushHeaders();
        setTimeout(() => req.socket.destroy(), 100);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const doc = await loadSpec(FIXTURE);
  await init(doc);
  const manifest = buildManifest(doc, { baseUrl: apiBase });
  const keyVar = manifest.auth.schemes[0]?.envVar;
  assert.ok(keyVar, 'fixture declares an apiKey scheme');
  await writeFile(join(OUT, 'operations.json'), JSON.stringify(manifest, null, 2));
  await copyFile(RUNTIME, join(OUT, 'server.mjs'));

  child = spawn(process.execPath, [join(OUT, 'server.mjs')], {
    env: { ...process.env, [keyVar]: 'secret-token', SPEC2MCP_MAX_RESPONSE_CHARS: '200' },
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
    clientInfo: { name: 'spec2mcp-e2e-runtime-fixes', version: '0.0.0' },
  });
  assert.ok((initRes.result as Record<string, unknown>)?.serverInfo);
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(async () => {
  child?.kill('SIGKILL');
  api?.close();
  await rm(OUT, { recursive: true, force: true });
});

test('#36 a single-field JSON body is sent, not {}', async () => {
  const res = await callTool('rename_pet', { name: 'Rex' });
  assert.ok(!res.isError, res.content?.[0]?.text ?? "tool call failed");
  const req = seen.get('POST /rename')?.at(-1);
  assert.equal(req?.body.toString('utf8'), JSON.stringify({ name: 'Rex' }));
});

test('#36 array request bodies still pass through raw', async () => {
  const res = await callTool('replace_items', { body: ['a', 'b'] });
  assert.ok(!res.isError, res.content?.[0]?.text ?? "tool call failed");
  const req = seen.get('POST /items')?.at(-1);
  assert.equal(req?.body.toString('utf8'), JSON.stringify(['a', 'b']));
});

test('#36 a field named __proto__ survives into the JSON body', async () => {
  const res = await callTool('weird_fields', { '__proto__': 'x', plain: 'y' });
  assert.ok(!res.isError, res.content?.[0]?.text ?? "tool call failed");
  const req = seen.get('POST /weird')?.at(-1);
  const sent = JSON.parse(req?.body.toString('utf8') ?? 'null');
  assert.ok(Object.prototype.hasOwnProperty.call(sent, '__proto__'), 'own __proto__ property present');
  assert.equal(sent.plain, 'y');
});

test('#37 structuredContent honours SPEC2MCP_MAX_RESPONSE_CHARS', async () => {
  const res = await callTool('get_big', {});
  assert.ok(!res.isError);
  assert.equal(res.structuredContent, undefined, 'oversized structured payload degrades to text-only');
  assert.match(res.content?.[0]?.text ?? '', /truncated/);
});

test('#38 an aborted response body is a tool error, not MCP -32603', async () => {
  const res = await callTool('get_abort', {});
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text ?? '', /Failed to read the response body/);
});

test('#39 corrupt base64 uploads are rejected before any request', async () => {
  for (const bad of ['!!!corrupt!!!', 'aGVs bG8=', 'aGVsbG8']) {
    const res = await callTool('upload_file', { file: { contentBase64: bad } });
    assert.equal(res.isError, true, `rejected: ${JSON.stringify(bad)}`);
    assert.match(res.content?.[0]?.text ?? '', /base64/);
  }
  assert.equal(seen.get('POST /upload'), undefined, 'no request reached the API');
  const good = await callTool('upload_file', { file: { contentBase64: Buffer.from('hello').toString('base64') } });
  assert.ok(!good.isError, good.content?.[0]?.text ?? "tool call failed");
  assert.equal(seen.get('POST /upload')?.length, 1);
});

test('#40 a 2xx with malformed JSON is an error, not silent success', async () => {
  const res = await callTool('get_data', {});
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text ?? '', /not valid JSON/);
  assert.match(res.content?.[0]?.text ?? '', /HTTP 200/);
});

test('#41 an apiKey query credential cannot be shadowed by a caller argument', async () => {
  const res = await callTool('get_secure', { api_key: 'evil' });
  assert.ok(!res.isError, res.content?.[0]?.text ?? "tool call failed");
  const req = seen.get('GET /secure')?.at(-1);
  const params = new URL(req?.url ?? '', apiBase).searchParams;
  assert.deepEqual(params.getAll('api_key'), ['secret-token'], 'exactly the credential, caller value gone');
});
