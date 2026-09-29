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
      tool('jsonString', 'POST', [bodyArg()], 'application/json'),
      tool('headerValue', 'POST', [{ name: 'xTrace', apiName: 'X-Trace', location: 'header', required: false, schema: { type: 'string' } }]),
      { ...tool('getFile', 'GET', [{ name: 'name', location: 'path', required: true, schema: { type: 'string' } }]), path: '/files/{name}/data' },
      tool('vendorJsonString', 'POST', [bodyArg()], 'application/vnd.test+json'),
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

test('#66 binary body base64 decodes to exact bytes, rejects corrupt input; text stays raw', async () => {
  for (const name of ['binary', 'image']) {
    const response = await call(name, { body: 'aGVsbG8=' });
    assert.equal(response.isError, undefined);
    assert.deepEqual(seen.at(-1)!.body, Buffer.from('hello'));
    assert.equal(seen.at(-1)!.headers['content-type'], name === 'binary' ? 'application/octet-stream' : 'image/png');
  }
  const count = seen.length;
  for (const body of ['aGVs bG8=', 'aGVsbG8', '!!!!']) {
    const response = await call('binary', { body });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /base64/);
  }
  assert.equal(seen.length, count);
  const text = await call('plain', { body: 'aGVsbG8=' });
  assert.equal(text.isError, undefined);
  assert.equal(seen.at(-1)!.body.toString('utf8'), 'aGVsbG8=');
});

test('#67 omitted optional body has no body or Content-Type; explicit empty object survives', async () => {
  const omitted = await call('optional');
  assert.equal(omitted.isError, undefined);
  assert.equal(seen.at(-1)!.body.length, 0);
  assert.equal(seen.at(-1)!.headers['content-type'], undefined);
  const explicit = await call('emptyObject', { body: {} });
  assert.equal(explicit.isError, undefined);
  assert.equal(seen.at(-1)!.body.toString('utf8'), '{}');
  assert.equal(seen.at(-1)!.headers['content-type'], 'application/json');
});

test('#68 base URL query stays a query while endpoint path appends to path', async () => {
  const result = await call('blob');
  assert.equal(result.isError, undefined);
  const url = new URL(seen.at(-1)!.url, 'http://localhost');
  assert.equal(url.pathname, '/api/blob');
  assert.equal(url.searchParams.get('tenant'), 'customer');
  assert.equal(url.searchParams.get('api_key'), credential);
});

test('#73 JSON top-level strings are quoted, including +json; text bodies stay raw', async () => {
  for (const name of ['jsonString', 'vendorJsonString']) {
    const result = await call(name, { body: 'hello' });
    assert.equal(result.isError, undefined);
    assert.equal(seen.at(-1)!.body.toString('utf8'), '"hello"');
    assert.equal(JSON.parse(seen.at(-1)!.body.toString('utf8')), 'hello');
  }
  const plain = await call('plain', { body: 'hello' });
  assert.equal(plain.isError, undefined);
  assert.equal(seen.at(-1)!.body.toString('utf8'), 'hello');
});

test('#77 malformed header arguments yield tool errors, not protocol exceptions', async () => {
  const count = seen.length;
  for (const xTrace of ['evil\r\nInjected: yes', 'bad\nvalue']) {
    const response = await call('headerValue', { xTrace });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Invalid request URL or header argument/);
  }
  assert.equal(seen.length, count, 'no invalid header request reached upstream');
  const ok = await call('headerValue', { xTrace: 'valid' });
  assert.equal(ok.isError, undefined);
  assert.equal(seen.at(-1)!.headers['x-trace'], 'valid');
});

test('#78 bare dot-segment path values cannot redirect the request', async () => {
  const count = seen.length;
  for (const name of ['.', '..']) {
    const response = await call('getFile', { name });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Invalid path argument.*dot segments/);
  }
  assert.equal(seen.length, count, 'no dot-segment request reached upstream');
  for (const name of ['%2e%2e', 'a/../b']) {
    const result = await call('getFile', { name });
    assert.equal(result.isError, undefined);
    assert.equal(seen.at(-1)!.url.split('?')[0], `/api/files/${encodeURIComponent(name)}/data`);
  }
});
