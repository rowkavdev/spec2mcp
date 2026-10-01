/**
 * Nulls inside object and array parameters (follow-up to #287). A null for a
 * nullable query, header or cookie parameter has no wire form in
 * OpenAPI; sending the text "null" would change what the API sees, so the
 * runtime leaves the parameter off. Checked over stdio against a recording
 * mock API.
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

const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const OUT = fileURLToPath(new URL('../.tmp-e2e-null-nested/', import.meta.url));
const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

const seen: { url?: string; headers: Record<string, string | string[] | undefined> }[] = [];
let api: HttpServer;
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

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };
const callTool = (name: string, args: Record<string, unknown>) =>
  rpc('tools/call', { name, arguments: args }).then((res) => res.result as ToolResult);

before(async () => {
  api = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const nullable = (extra: Record<string, unknown>) => ({ nullable: true, ...extra });
  const doc = {
    openapi: '3.0.3', info: { title: 'Nested null parameters', version: '1' }, components: { schemas: {} },
    paths: { '/search': { get: {
      operationId: 'search',
      parameters: [
        { name: 'filter', in: 'query', style: 'deepObject', explode: true, schema: { type: 'object', additionalProperties: nullable({ type: 'string' }) } },
        { name: 'opts', in: 'query', style: 'form', explode: true, schema: { type: 'object', additionalProperties: nullable({ type: 'string' }) } },
        { name: 'tags', in: 'query', style: 'form', explode: false, schema: { type: 'array', items: nullable({ type: 'string' }) } },
        { name: 'x-ids', in: 'header', schema: { type: 'array', items: nullable({ type: 'string' }) } },
      ],
      responses: { '200': { description: 'OK' } },
    } } },
  };
  const specPath = join(OUT, 'spec.json');
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(specPath, JSON.stringify(doc));
  const spec = await loadSpec(specPath);
  await init(spec);
  await writeFile(join(OUT, 'operations.json'), JSON.stringify(buildManifest(spec, { baseUrl: apiBase }), null, 2));
  await copyFile(RUNTIME, join(OUT, 'server.mjs'));
  child = spawn(process.execPath, [join(OUT, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(async () => {
  child?.kill();
  await new Promise<void>((r) => api.close(() => r()));
  await rm(OUT, { recursive: true, force: true });
});

test('a null property inside an object parameter is left off', async () => {
  const res = await callTool('search', { filter: { a: '1', b: null }, opts: { c: null, d: '2' } });
  assert.ok(!res.isError, `call failed: ${res.content?.[0]?.text ?? ''}`);
  assert.equal(seen.at(-1)!.url, '/search?filter%5Ba%5D=1&d=2');
});

test('an array or object holding only nulls sends no parameter at all', async () => {
  const res = await callTool('search', { filter: { a: null }, tags: [null, null], 'x-ids': [null] });
  assert.ok(!res.isError, `call failed: ${res.content?.[0]?.text ?? ''}`);
  const call = seen.at(-1)!;
  assert.equal(call.url, '/search');
  assert.equal(call.headers['x-ids'], undefined);
});

test('real values in a non-exploded array still serialize, minus nulls', async () => {
  const res = await callTool('search', { tags: ['a', null, 'b'], 'x-ids': ['1', null, '2'] });
  assert.ok(!res.isError, `call failed: ${res.content?.[0]?.text ?? ''}`);
  const call = seen.at(-1)!;
  assert.equal(call.url, '/search?tags=a%2Cb');
  assert.equal(call.headers['x-ids'], '1,2');
});
