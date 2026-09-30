/**
 * #146: security requirement objects in an array are OR alternatives. The
 * manifest preserves every fully mapped alternative, and the runtime picks
 * the first whose credentials are all configured - so with the first
 * scheme's env var unset but a later alternative configured, the call goes
 * out authenticated through the later route instead of anonymously.
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
const OUT = fileURLToPath(new URL('../.tmp-e2e-auth-alternatives/', import.meta.url));
const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

const seen: { authorization: string | undefined; apiKey: string | undefined }[] = [];
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
      seen.push({
        authorization: req.headers.authorization as string | undefined,
        apiKey: req.headers['x-api-key'] as string | undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const doc = {
    openapi: '3.0.3',
    info: { title: 'Auth', version: '1' },
    components: {
      schemas: {},
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer' },
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
    security: [{ BearerAuth: [] }, { ApiKey: [] }],
    paths: { '/me': { get: { operationId: 'getMe', responses: { '200': { description: 'OK' } } } } },
  };
  const specPath = join(OUT, 'spec.json');
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(specPath, JSON.stringify(doc));
  const spec = await loadSpec(specPath);
  await init(spec);
  const manifest = buildManifest(spec, { baseUrl: apiBase });

  // Manifest shape: both OR alternatives survive, first-complete order kept.
  const tool = manifest.tools.find((t) => t.name === 'get_me');
  assert.ok(tool);
  assert.deepEqual(tool.authSchemeNames, ['BearerAuth'], 'first alternative stays the legacy selection');
  assert.deepEqual(tool.authAlternatives, [['BearerAuth'], ['ApiKey']], 'every mapped alternative is preserved');
  assert.equal(manifest.auth.schemes.length, 2, 'both schemes are emitted');

  // Configure only the second alternative's credential.
  const apiKeyScheme = manifest.auth.schemes.find((s) => s.schemeName === 'ApiKey');
  assert.ok(apiKeyScheme);
  process.env[apiKeyScheme.envVar] = 'available';

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

test('#146 the configured later alternative authenticates the call', async () => {
  const res = await callTool('get_me', {});
  assert.ok(!res.isError, `call failed: ${res.content?.[0]?.text ?? ''}`);
  const last = seen.at(-1);
  assert.equal(last?.apiKey, 'available', 'the configured API-key credential is sent');
  assert.equal(last?.authorization, undefined, 'no Bearer header for the unset first alternative');
});
