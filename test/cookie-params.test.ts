/**
 * #138: cookie parameters must reach the tool schema and the wire. Forge's
 * resolver collects path/query/header parameters only, so cookie params
 * silently vanished; the manifest now extracts them from the source and the
 * runtime serializes a Cookie header. Over stdio against a recording mock
 * API: the wire header carries name=value pairs, percent-encoded, joined
 * with "; ", and an existing Cookie header is extended, not overwritten.
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
const OUT = fileURLToPath(new URL('../.tmp-e2e-cookie-params/', import.meta.url));
const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

const seenCookies: (string | undefined)[] = [];
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
      seenCookies.push(req.headers.cookie as string | undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const doc = {
    openapi: '3.0.3',
    info: { title: 'Cookies', version: '1' },
    components: { schemas: {} },
    paths: { '/profile': { get: {
      operationId: 'getProfile',
      parameters: [
        { name: 'session', in: 'cookie', required: true, schema: { type: 'string' } },
        { name: 'prefs', in: 'cookie', schema: { type: 'array', items: { type: 'integer', enum: [1, 2] } } },
        { name: 'tier', in: 'cookie', schema: { type: 'integer', enum: [1, 2], default: 1, description: 'Account tier' } },
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
  const manifest = buildManifest(spec, { baseUrl: apiBase });

  // Manifest shape: cookie params are exposed with schema and requiredness.
  const tool = manifest.tools.find((t) => t.name === 'get_profile');
  assert.ok(tool);
  const session = tool.args.find((a) => a.name === 'session');
  assert.ok(session, 'cookie param exposed');
  assert.equal(session.location, 'cookie');
  assert.equal(session.required, true);
  assert.deepEqual(session.schema, { type: 'string' });
  const prefs = tool.args.find((a) => a.name === 'prefs');
  assert.deepEqual(prefs?.schema, { type: 'array', items: { type: 'integer', enum: [1, 2] } }, 'source enum keeps primitive types');
  const tier = tool.args.find((a) => a.name === 'tier');
  assert.deepEqual(tier?.schema, { type: 'integer', enum: [1, 2], default: 1, description: 'Account tier' });

  await writeFile(join(OUT, 'operations.json'), JSON.stringify(manifest, null, 2));
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
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(async () => {
  child?.kill();
  await new Promise<void>((r) => api.close(() => r()));
  await rm(OUT, { recursive: true, force: true });
});

test('#138 the Cookie header carries the serialized cookie parameters', async () => {
  const res = await callTool('get_profile', { session: 'a b;', prefs: [1, 2], tier: 2 });
  assert.ok(!res.isError, `call failed: ${res.content?.[0]?.text ?? ''}`);
  assert.equal(seenCookies.at(-1), 'session=a%20b%3B; prefs=1; prefs=2; tier=2');
});

test('#138 a required cookie parameter is enforced', async () => {
  const res = await callTool('get_profile', {});
  assert.match(res.content?.[0]?.text ?? '', /Missing required argument.*session/);
});
