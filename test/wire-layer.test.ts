import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const OUT = fileURLToPath(new URL('../.tmp-e2e-wire/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const credential = 'secret-inline-key';
type Seen = { url: string; headers: Record<string, unknown>; body: Buffer };
const seen: Seen[] = [];
let api: HttpServer;
let child: ChildProcess;
let buffer = '';
let nextId = 1;
const pending = new Map<number, (message: any) => void>();

function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
};
const bodyArg = (required = false) => ({ name: 'body', location: 'body', apiFieldPath: [], required, schema: {} });
const tool = (name: string, method = 'GET', args: Record<string, unknown>[] = [], contentType?: string) => ({
  name, operationId: name, description: name, method, path: `/${name}`, args,
  inputSchema: { type: 'object', properties: Object.fromEntries(args.map((a) => [a.name, a.schema])), required: args.filter((a) => a.required).map((a) => a.name) },
  ...(contentType ? { contentType } : {}),
});

before(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': req.url?.startsWith('/api/blob') ? 'application/pdf' : 'application/json' });
      res.end(req.url?.startsWith('/api/blob') ? Buffer.from('%PDF-test') : '{}');
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api?tenant=customer`;
  const manifest = {
    serverName: 'wire-test', apiVersion: '1', baseUrl,
    auth: { schemes: [{ kind: 'apikey-query', schemeName: 'key', envVar: 'WIRE_TEST_KEY', queryName: 'api_key' }] },
    tools: [
      tool('blob'),
      tool('binary', 'POST', [bodyArg()], 'application/octet-stream'),
      tool('image', 'POST', [bodyArg()], 'image/png'),
      tool('plain', 'POST', [bodyArg()], 'text/plain'),
      tool('optional', 'POST', [{ name: 'name', location: 'body', apiFieldPath: ['name'], required: false, schema: { type: 'string' } }], 'application/json'),
      tool('emptyObject', 'POST', [bodyArg()], 'application/json'),
    ],
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/operations.json`, JSON.stringify(manifest));
  await copyFile(RUNTIME, `${OUT}/server.mjs`);
  child = spawn(process.execPath, [`${OUT}/server.mjs`], { env: { ...process.env, WIRE_TEST_KEY: credential }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout!.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
    }
  });
  child.stderr!.on('data', () => {});
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wire-test', version: '1' } });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});
after(async () => { child?.kill('SIGKILL'); api?.close(); await rm(OUT, { recursive: true, force: true }); });

test('#64 inline binary resources use opaque URIs, not upstream URLs carrying API keys', async () => {
  const result = await call('blob');
  assert.equal(result.isError, undefined);
  const resource = result.content[0].resource;
  assert.equal(resource.blob, Buffer.from('%PDF-test').toString('base64'));
  assert.match(resource.uri, /^urn:uuid:[0-9a-f-]+$/);
  assert.ok(!JSON.stringify(result).includes(credential));
  const request = seen.at(-1)!;
  assert.equal(new URL(request.url, 'http://localhost').searchParams.get('api_key'), credential);
});

