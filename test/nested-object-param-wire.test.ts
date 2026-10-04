/**
 * Nested values inside an object query/header parameter were stringified to
 * "[object Object]". deepObject now sends filter[a][b]=x; styles with no
 * nested form fail with a clear error. Checked over stdio against a mock API.
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
const OUT = fileURLToPath(new URL('../.tmp-e2e-nested-object-param/', import.meta.url));
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
    openapi: '3.0.3', info: { title: 'Nested object params', version: '1' }, components: { schemas: {} },
    paths: { '/search': { get: {
      operationId: 'search',
      parameters: [
        { name: 'filter', in: 'query', style: 'deepObject', explode: true, schema: { type: 'object', additionalProperties: true } },
        { name: 'records', in: 'query', schema: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        { name: 'x-records', in: 'header', schema: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        { name: 'cookies', in: 'cookie', schema: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        { name: 'plain', in: 'query', schema: { type: 'object', additionalProperties: true } },
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

test('a nested deepObject is sent as bracketed keys', async () => {
  const res = await callTool('search', { filter: { a: { b: 'x', c: 1 }, tags: ['p', 'q'], top: 'y' } });
  assert.ok(!res.isError, `call failed: ${res.content?.[0]?.text ?? ''}`);
  assert.equal(seen.at(-1)!.url, '/search?filter%5Ba%5D%5Bb%5D=x&filter%5Ba%5D%5Bc%5D=1&filter%5Btags%5D=p%2Cq&filter%5Btop%5D=y');
});

test('a nested object in a form-style object parameter is an error, not [object Object]', async () => {
  const before = seen.length;
  const res = await callTool('search', { plain: { a: { b: 'x' } } });
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text ?? '', /nested object/);
  assert.equal(seen.length, before);
});

test('arrays of objects in query, header and cookie parameters fail without an upstream call', async () => {
  for (const name of ['records', 'x-records', 'cookies']) {
    const before = seen.length;
    const res = await callTool('search', { [name]: [{ id: 1 }] });
    assert.equal(res.isError, true, name);
    assert.match(res.content?.[0]?.text ?? '', /array of objects/);
    assert.equal(seen.length, before, name);
  }
});

test('nested deepObject arrays omit null elements without adding empty values', async () => {
  const res = await callTool('search', { filter: { tags: ['a', null, 'b'], empty: [null, null] } });
  assert.ok(!res.isError, res.content?.[0]?.text ?? '');
  assert.equal(seen.at(-1)!.url, '/search?filter%5Btags%5D=a%2Cb');
});
