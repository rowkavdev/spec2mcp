/**
 * Form bodies whose fields declare style deepObject (Stripe's whole write API).
 * Every call failed with "Unsupported form encoding" even when the field was
 * not sent. Checked over stdio against a recording mock API.
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
const OUT = fileURLToPath(new URL('../.tmp-e2e-form-deepobject/', import.meta.url));
const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

const seen: { url?: string; body: string; headers: Record<string, string | string[] | undefined> }[] = [];
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
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: raw, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const nullable = (extra: Record<string, unknown>) => ({ nullable: true, ...extra });
  const doc = {
    openapi: '3.0.3', info: { title: 'DeepObject form bodies', version: '1' }, components: { schemas: {} },
    paths: { '/search': { post: {
      operationId: 'search',
      requestBody: { content: { 'application/x-www-form-urlencoded': {
        schema: { type: 'object', properties: {
          email: { type: 'string' },
          metadata: { type: 'object', additionalProperties: { type: 'string' } },
          address: { type: 'object', properties: { city: { type: 'string' }, line1: { type: 'string' } } },
          expand: { type: 'array', items: { type: 'string' } },
          items: { type: 'array', items: { type: 'object', properties: { price: { type: 'string' }, quantity: { type: 'integer' } } } },
        } },
        encoding: {
          metadata: { style: 'deepObject', explode: true },
          address: { style: 'deepObject', explode: true },
          expand: { style: 'deepObject', explode: true },
          items: { style: 'deepObject', explode: true },
        },
      } } },
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

const enc = (body: Record<string, unknown>) => callTool('search', { body }).then((res) => {
  assert.ok(!res.isError, `call failed: ${res.content?.[0]?.text ?? ''}`);
  return decodeURIComponent(seen.at(-1)!.body.replace(/\+/g, ' '));
});

test('a plain field still works when other fields use deepObject (Stripe: any create call)', async () => {
  assert.equal(await enc({ email: 'a@b.co' }), 'email=a@b.co');
});

test('deepObject objects and arrays use Stripe-style bracket keys', async () => {
  assert.equal(
    await enc({ email: 'a@b.co', metadata: { plan: 'pro' }, address: { city: 'X' }, expand: ['data', 'customer'], items: [{ price: 'p1', quantity: 2 }, { price: 'p2' }] }),
    'email=a@b.co&metadata[plan]=pro&address[city]=X&expand[]=data&expand[]=customer&items[0][price]=p1&items[0][quantity]=2&items[1][price]=p2',
  );
});

test('null values and empty containers are left out of a deepObject field', async () => {
  assert.equal(await enc({ email: 'a@b.co', metadata: { a: 'x', b: null }, expand: [], address: {} }), 'email=a@b.co&metadata[a]=x');
});
