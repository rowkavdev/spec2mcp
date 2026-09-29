/**
 * Parameter-name collisions across locations: real specs reuse one name in
 * query and body (Spotify "uris", Vercel "teamId") or in a path template and
 * query (Kubernetes "path"). The manifest must keep both arguments, rename
 * the later one deterministically, and the runtime must still send it on the
 * wire under the API's own name.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest, type Manifest } from '../src/manifest.js';

const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
// Scratch dir inside the repo so the generated server.mjs resolves
// @modelcontextprotocol/sdk from this repo's node_modules.
const OUT = fileURLToPath(new URL('../.tmp-collision/', import.meta.url));

// Query param "uris" + body field "uris", the Spotify shape.
const DOC = {
  openapi: '3.0.3',
  info: { title: 'Collision API', version: '1.0.0' },
  servers: [{ url: 'http://placeholder.invalid' }],
  paths: {
    '/items': {
      post: {
        operationId: 'addItems',
        parameters: [
          { name: 'uris', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'position', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  uris: { type: 'array', items: { type: 'string' } },
                  position: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
  },
  components: { schemas: {} },
} as unknown as OpenAPIV3.Document;

test('colliding args are renamed with the API wire name preserved', async () => {
  await init(DOC);
  const m = buildManifest(DOC);
  const tool = m.tools.find((t) => t.name === 'add_items');
  assert.ok(tool);
  const argNames = tool.args.map((a) => a.name);
  assert.equal(new Set(argNames).size, argNames.length, 'arg names unique');
  assert.deepEqual(argNames.sort(), ['position', 'position_body', 'uris', 'uris_body']);

  const queryUris = tool.args.find((a) => a.name === 'uris');
  assert.equal(queryUris?.location, 'query', 'first occurrence keeps the bare name');
  assert.equal(queryUris?.apiName, undefined);

  const bodyUris = tool.args.find((a) => a.name === 'uris_body');
  assert.equal(bodyUris?.location, 'body');
  assert.deepEqual(bodyUris?.apiFieldPath, ['uris']);

  const properties = Object.keys(tool.inputSchema.properties as Record<string, unknown>);
  assert.deepEqual(properties.sort(), argNames.sort(), 'every arg survives in the input schema');
});

// Wire-level: boot the runtime with the same manifest and check what the
// mock API receives.
const seen: { url: string; body: string }[] = [];
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

before(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  await init(DOC);
  const manifest: Manifest = buildManifest(DOC, { baseUrl: apiBase });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}operations.json`, JSON.stringify(manifest, null, 2));
  await copyFile(RUNTIME, `${OUT}server.mjs`);

  child = spawn(process.execPath, [`${OUT}server.mjs`], { stdio: ['pipe', 'pipe', 'pipe'] });
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

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spec2mcp-collision', version: '0.0.0' },
  });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(async () => {
  child?.kill('SIGKILL');
  api?.close();
  await rm(OUT, { recursive: true, force: true });
});

test('renamed args go on the wire under the API name', async () => {
  seen.length = 0;
  const res = await rpc('tools/call', {
    name: 'add_items',
    arguments: { uris: 'spotify:track:1', uris_body: ['spotify:track:2'], position_body: 4 },
  });
  assert.notEqual((res.result as Record<string, unknown>).isError, true);
  assert.equal(seen.length, 1);
  // Query keeps the API's own name ("uris"), not the tool-facing rename.
  assert.equal(seen[0]!.url, '/items?uris=spotify%3Atrack%3A1');
  // Body is reconstructed from apiFieldPath under the original field name.
  assert.deepEqual(JSON.parse(seen[0]!.body), { uris: ['spotify:track:2'], position: 4 });
});
