/**
 * #120: a nullable object body parent flattens to leaves in Forge's view.
 * The manifest retains a parent arg accepting object|null alongside the
 * leaves; over stdio against a recording mock API: pet:null reaches the
 * wire as {"pet":null}, the pet.id leaf still builds the object, a provided
 * object passes through, and required-parent semantics hold.
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

const { compileOutputValidator } = (await import(
  new URL('../runtime/server.mjs', import.meta.url).href
)) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

const FIXTURE = fileURLToPath(new URL('./fixtures/nullable-parent-31.yaml', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const OUT = fileURLToPath(new URL('../.tmp-e2e-nullable-parent/', import.meta.url));
const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

const seen: { body: Buffer }[] = [];
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
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ body: Buffer.concat(chunks) });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const doc = await loadSpec(FIXTURE);
  await init(doc);
  const manifest = buildManifest(doc, { baseUrl: apiBase });

  // Manifest shape: the nullable parent coexists with its leaf.
  const tool = manifest.tools.find((t) => t.name === 'create_pet');
  assert.ok(tool);
  const parent = tool.args.find((a) => a.name === 'pet');
  assert.ok(parent, 'parent arg retained');
  assert.equal(parent.required, true, 'required parent stays required');
  assert.deepEqual(parent.schema.anyOf, [
    { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    { type: 'null' },
  ]);
  const leaf = tool.args.find((a) => a.name === 'pet.id');
  assert.ok(leaf, 'leaf arg intact');
  assert.equal(leaf.required, true, 'required leaf stays required at the arg level');

  // #122: pet and pet.id cannot both sit in a flat `required` list - that
  // would make the null branch inaccessible. The input schema uses
  // conditional clauses instead: presence is pet OR pet.id, and pet.id is
  // itself OR pet; pet.id-when-object is enforced inside the parent arg's
  // object branch above.
  const inputSchema = tool.inputSchema as { required?: string[]; allOf?: Record<string, unknown>[] };
  assert.ok(!inputSchema.required?.includes('pet'), 'pet not flatly required');
  assert.ok(!inputSchema.required?.includes('pet.id'), 'pet.id not flatly required');
  assert.ok(Array.isArray(inputSchema.allOf), 'conditional clauses present');
  const validate = compileOutputValidator(inputSchema);
  assert.ok(validate({ pet: null }), '{pet:null} accepted');
  assert.ok(validate({ 'pet.id': 'x' }), 'leaf-only accepted');
  assert.ok(validate({ pet: { id: 'x' } }), 'parent object accepted');
  assert.ok(!validate({ pet: {} }), 'pet.id required when pet is an object');
  assert.ok(!validate({}), 'presence enforced');

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
  child.stderr!.on('data', () => {});
  const initRes = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spec2mcp-e2e-nullable-parent', version: '0.0.0' },
  });
  assert.ok((initRes.result as Record<string, unknown>)?.serverInfo);
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(async () => {
  child?.kill('SIGKILL');
  api?.close();
  await rm(OUT, { recursive: true, force: true });
});

test('#120 pet:null reaches the wire as {"pet":null}', async () => {
  const res = await callTool('create_pet', { pet: null });
  assert.ok(!res.isError, res.content?.[0]?.text ?? 'tool call failed');
  assert.equal(seen.at(-1)?.body.toString('utf8'), '{"pet":null}');
});

test('#120 the pet.id leaf still builds the object', async () => {
  const res = await callTool('create_pet', { 'pet.id': 'x' });
  assert.ok(!res.isError, res.content?.[0]?.text ?? 'tool call failed');
  assert.equal(seen.at(-1)?.body.toString('utf8'), '{"pet":{"id":"x"}}');
});

test('#120 a provided parent object passes through', async () => {
  const res = await callTool('create_pet', { pet: { id: 'y', extra: true } });
  assert.ok(!res.isError, res.content?.[0]?.text ?? 'tool call failed');
  assert.equal(seen.at(-1)?.body.toString('utf8'), '{"pet":{"id":"y","extra":true}}');
});

test('#120 the required parent is enforced when nothing covers it', async () => {
  const res = await callTool('create_pet', {});
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text ?? '', /Missing required argument.*pet/);
});
