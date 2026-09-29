import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const OUT = fileURLToPath(new URL('../.tmp-redirect-security/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
let source: HttpServer;
let target: HttpServer;
let child: ChildProcess;
let buffer = '';
let targetHits = 0;
let sourceHits = 0;
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
before(async () => {
  target = createServer((req, res) => { targetHits++; req.resume(); res.end('{}'); });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/sink`;
  source = createServer((req, res) => {
    sourceHits++;
    req.resume();
    res.writeHead(307, { location: targetUrl });
    res.end();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const manifest = { serverName: 'redirect-test', apiVersion: '1', baseUrl,
    auth: { schemes: [{ schemeName: 'apiKey', kind: 'apikey-header', envVar: 'REDIRECT_SECRET', headerName: 'X-API-Key' }] },
    tools: [{ name: 'post', operationId: 'post', method: 'POST', path: '/redirect', args: [{ name: 'body', location: 'body', required: true, apiFieldPath: [], schema: { type: 'string' } }],
      contentType: 'text/plain', inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] } }],
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/operations.json`, JSON.stringify(manifest));
  await copyFile(RUNTIME, `${OUT}/server.mjs`);
  child = spawn(process.execPath, [`${OUT}/server.mjs`], { env: { ...process.env, REDIRECT_SECRET: 'never-forward-me' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout!.on('data', (chunk) => {
    buffer += chunk.toString(); let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    }
  });
  child.stderr!.on('data', () => {});
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'redirect-test', version: '1' } });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});
after(async () => { child?.kill('SIGKILL'); source?.close(); target?.close(); await rm(OUT, { recursive: true, force: true }); });
test('#98 cross-origin 307 never forwards API key or body', async () => {
  const result = await rpc('tools/call', { name: 'post', arguments: { body: 'private request body' } });
  assert.equal(result.error, undefined);
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /redirect not followed/);
  assert.ok(!JSON.stringify(result).includes('never-forward-me'));
  assert.ok(!JSON.stringify(result).includes('http://127.0.0.1'));
  assert.equal(sourceHits, 1);
  assert.equal(targetHits, 0);
});

test('#97 credentialed base URL fetch error does not echo username, password or URL', async () => {
  const dir = `${OUT}-credentials`;
  await mkdir(dir, { recursive: true });
  const port = (source.address() as AddressInfo).port;
  const username = 'private-user';
  const password = 'private-pass';
  const manifest = {
    serverName: 'credential-test', apiVersion: '1',
    baseUrl: `http://${username}:${password}@127.0.0.1:${port}/`,
    auth: { schemes: [] },
    tools: [{ name: 'check', operationId: 'check', method: 'GET', path: '/check', args: [],
      inputSchema: { type: 'object', properties: {}, required: [] } }],
  };
  await writeFile(`${dir}/operations.json`, JSON.stringify(manifest));
  await copyFile(RUNTIME, `${dir}/server.mjs`);
  const second = spawn(process.execPath, [`${dir}/server.mjs`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let secondBuffer = '';
  const reply = new Map<number, (message: any) => void>();
  second.stdout!.on('data', (chunk) => {
    secondBuffer += chunk.toString(); let i: number;
    while ((i = secondBuffer.indexOf('\n')) >= 0) {
      const line = secondBuffer.slice(0, i); secondBuffer = secondBuffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (reply.has(message.id)) { reply.get(message.id)!(message); reply.delete(message.id); }
    }
  });
  second.stderr!.on('data', () => {});
  let id = 1;
  const secondRpc = (method: string, params?: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
    const currentId = id++;
    const timer = setTimeout(() => reject(new Error('credential test RPC timeout')), 10_000);
    reply.set(currentId, (message) => { clearTimeout(timer); resolve(message); });
    second.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: currentId, method, params }) + '\n');
  });
  try {
    await secondRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'credential-test', version: '1' } });
    second.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const result = await secondRpc('tools/call', { name: 'check', arguments: {} });
    assert.equal(result.error, undefined);
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /Request failed/);
    assert.ok(!JSON.stringify(result).includes(username));
    assert.ok(!JSON.stringify(result).includes(password));
    assert.ok(!JSON.stringify(result).includes(`127.0.0.1:${port}`));
  } finally {
    second.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
