/**
 * Regression tests for the verified runtime bug batch (#36-#41): generate a
 * server from the runtime-fixes fixture, boot it over stdio, and drive real
 * MCP tool calls against a mock HTTP API that records requests and serves
 * malformed, aborted and oversized responses.
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

const FIXTURE = fileURLToPath(new URL('./fixtures/runtime-fixes.yaml', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));
const OUT = fileURLToPath(new URL('../.tmp-e2e-runtime-fixes/', import.meta.url));

const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

type SeenRequest = { method: string; url: string; body: Buffer };
const seen = new Map<string, SeenRequest[]>();
let api: HttpServer;
let apiBase: string;
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

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown };
const callTool = (name: string, args: Record<string, unknown>) =>
  rpc('tools/call', { name, arguments: args }).then((res) => res.result as ToolResult);

before(async () => {
  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const key = `${req.method} ${url.split('?')[0]}`;
      const list = seen.get(key) ?? [];
      list.push({ method: req.method ?? '', url, body: Buffer.concat(chunks) });
      seen.set(key, list);
      if (url.startsWith('/text-bad')) {
        res.writeHead(200, { 'content-type': url.includes('charset') ? 'text/plain; charset=utf-8' : 'text/plain' });
        res.end(Buffer.from([0xff, 0, 0x41]));
      } else if (url.startsWith('/text-valid')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('café ' + String.fromCharCode(0xfffd));
      } else if (url.startsWith('/untyped')) {
        res.writeHead(200);
        res.end(Buffer.from([0xff, 0, 0x41]));
      } else if (url.startsWith('/xml-latin1')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><name>caf\xe9</name>', 'latin1'));
      } else if (url.startsWith('/xml-utf16')) {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<name>café</name>', 'utf16le')]));
      } else if (url.startsWith('/data')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{not valid json');
      } else if (url.startsWith('/bad-utf8')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // A lossy UTF-8 decode yields valid JSON with a replacement char.
        res.end(Buffer.from([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
      } else if (url.startsWith('/big')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: 'x'.repeat(5000) }));
      } else if (url.startsWith('/abort')) {
        // Deliver headers and a partial chunked body, then cut the
        // connection: fetch resolves the response and arrayBuffer() rejects.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial":');
        res.flushHeaders();
        setTimeout(() => req.socket.destroy(), 100);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const doc = await loadSpec(FIXTURE);
  await init(doc);
  const manifest = buildManifest(doc, { baseUrl: apiBase });
  for (const [name, path] of [['get_xml_latin1', '/xml-latin1'], ['get_xml_utf16', '/xml-utf16'], ['get_text_bad', '/text-bad'], ['get_text_bad_charset', '/text-bad-charset'], ['get_text_valid', '/text-valid'], ['get_untyped', '/untyped']] as const) {
    manifest.tools.push({ name, operationId: name, method: 'GET', path, description: name,
      tags: [], args: [], authSchemeNames: [], inputSchema: { type: 'object', properties: {}, required: [] } });
  }
  const keyVar = manifest.auth.schemes[0]?.envVar;
  assert.ok(keyVar, 'fixture declares an apiKey scheme');
  await writeFile(join(OUT, 'operations.json'), JSON.stringify(manifest, null, 2));
  await copyFile(RUNTIME, join(OUT, 'server.mjs'));

  child = spawn(process.execPath, [join(OUT, 'server.mjs')], {
    env: { ...process.env, [keyVar]: 'secret-token', SPEC2MCP_MAX_RESPONSE_CHARS: '200' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
    clientInfo: { name: 'spec2mcp-e2e-runtime-fixes', version: '0.0.0' },
  });
  assert.ok((initRes.result as Record<string, unknown>)?.serverInfo);
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(async () => {
  child?.kill('SIGKILL');
  api?.close();
  await rm(OUT, { recursive: true, force: true });
});

test('#36 a single-field JSON body is sent, not {}', async () => {
  const res = await callTool('rename_pet', { name: 'Rex' });
  assert.ok(!res.isError, res.content?.[0]?.text ?? "tool call failed");
  const req = seen.get('POST /rename')?.at(-1);
  assert.equal(req?.body.toString('utf8'), JSON.stringify({ name: 'Rex' }));
});

test('#36 array request bodies still pass through raw', async () => {
  const res = await callTool('replace_items', { body: ['a', 'b'] });
  assert.ok(!res.isError, res.content?.[0]?.text ?? "tool call failed");
  const req = seen.get('POST /items')?.at(-1);
  assert.equal(req?.body.toString('utf8'), JSON.stringify(['a', 'b']));
});

test('#36 a field named __proto__ survives into the JSON body', async () => {
  const res = await callTool('weird_fields', { '__proto__': 'x', plain: 'y' });
  assert.ok(!res.isError, res.content?.[0]?.text ?? "tool call failed");
  const req = seen.get('POST /weird')?.at(-1);
  const sent = JSON.parse(req?.body.toString('utf8') ?? 'null');
  assert.ok(Object.prototype.hasOwnProperty.call(sent, '__proto__'), 'own __proto__ property present');
  assert.equal(sent.plain, 'y');
});

test('#59 a path param named body does not swallow the raw request body', async () => {
  const res = await callTool('replace_thing', { body: 'widget-1', body_body: ['a', 'b'] });
  assert.ok(!res.isError, res.content?.[0]?.text ?? 'tool call failed');
  const req = seen.get('POST /things/widget-1')?.at(-1);
  assert.equal(req?.body.toString('utf8'), JSON.stringify(['a', 'b']), 'raw array body sent under its disambiguated name');
});

test('#37 structuredContent honours SPEC2MCP_MAX_RESPONSE_CHARS', async () => {
  const res = await callTool('get_big', {});
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent, undefined, 'oversized structured payload becomes a tool error');
  assert.match(res.content?.[0]?.text ?? '', /truncated/);
});

test('#38 an aborted response body is a tool error, not MCP -32603', async () => {
  const res = await callTool('get_abort', {});
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text ?? '', /Failed to read the response body/);
});

test('#39 corrupt base64 uploads are rejected before any request', async () => {
  for (const bad of ['!!!corrupt!!!', 'aGVs bG8=', 'aGVsbG8']) {
    const res = await callTool('upload_file', { file: { contentBase64: bad } });
    assert.equal(res.isError, true, `rejected: ${JSON.stringify(bad)}`);
    assert.match(res.content?.[0]?.text ?? '', /base64/);
  }
  assert.equal(seen.get('POST /upload'), undefined, 'no request reached the API');
  const good = await callTool('upload_file', { file: { contentBase64: Buffer.from('hello').toString('base64') } });
  assert.ok(!good.isError, good.content?.[0]?.text ?? "tool call failed");
  assert.equal(seen.get('POST /upload')?.length, 1);
});

test('#40 a 2xx with malformed JSON is an error, not silent success', async () => {
  const res = await callTool('get_data', {});
  assert.equal(res.isError, true);
  assert.match(res.content?.[0]?.text ?? '', /not valid JSON/);
  assert.match(res.content?.[0]?.text ?? '', /HTTP 200/);
});

test('#41 an apiKey query credential cannot be shadowed by a caller argument', async () => {
  const res = await callTool('get_secure', { api_key: 'evil' });
  assert.ok(!res.isError, res.content?.[0]?.text ?? "tool call failed");
  const req = seen.get('GET /secure')?.at(-1);
  const params = new URL(req?.url ?? '', apiBase).searchParams;
  assert.deepEqual(params.getAll('api_key'), ['secret-token'], 'exactly the credential, caller value gone');
});

test('#103 invalid UTF-8 in declared JSON is a tool error, not repaired success', async () => {
  const result = await callTool('get_bad_utf8', {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content?.[0]?.text ?? '', /not valid JSON.*invalid UTF-8/);
  assert.match(result.content?.[0]?.text ?? '', /\uFFFD/);
});


test('#174 XML declaration and UTF-16 BOM determine response decoding without HTTP charset', async () => {
  const latin = await callTool('get_xml_latin1', {});
  assert.equal(latin.isError, undefined);
  assert.match(latin.content?.[0]?.text ?? '', /café/);
  const utf16 = await callTool('get_xml_utf16', {});
  assert.equal(utf16.isError, undefined);
  assert.match(utf16.content?.[0]?.text ?? '', /café/);
});

test('#139 a supplied zero-byte file is sent with its filename', async () => {
  const before = seen.get('POST /upload')?.length ?? 0;
  const res = await callTool('upload_file', { file: { contentBase64: '', filename: 'empty.txt', mimeType: 'text/plain' } });
  assert.ok(!res.isError, res.content?.[0]?.text ?? 'tool call failed');
  assert.equal(seen.get('POST /upload')?.length, before + 1);
  const body = seen.get('POST /upload')!.at(-1)!.body.toString('utf8');
  assert.match(body, /name="file"; filename="empty.txt"\r\nContent-Type: text\/plain\r\n\r\n\r\n--/);
  for (const invalid of [null, {}, { contentBase64: null }, { contentBase64: 'AB==' }]) {
    const rejected = await callTool('upload_file', { file: invalid });
    assert.equal(rejected.isError, true);
  }
  assert.equal(seen.get('POST /upload')?.length, before + 1, 'invalid file values still never reach API');
});

test('#155 malformed Unicode path is a tool error, not a protocol error', async () => {
  const before = seen.get('POST /things/' + String.fromCharCode(0xd800))?.length ?? 0;
  const reply = await rpc('tools/call', { name: 'replace_thing', arguments: { body: String.fromCharCode(0xd800), body_body: ['a'] } });
  assert.equal(reply.error, undefined, 'argument error must not escape as MCP -32603');
  const result = reply.result as ToolResult;
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? '', /Invalid path argument/);
  assert.equal(seen.get('POST /things/' + String.fromCharCode(0xd800))?.length ?? 0, before);
});

test('#171 invalid UTF-8 text is not a lossy success', async () => {
  for (const tool of ['get_text_bad', 'get_text_bad_charset']) {
    const result = await callTool(tool, {});
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /could not be decoded/);
  }
  const valid = await callTool('get_text_valid', {});
  assert.ok(!valid.isError);
  assert.equal(valid.content?.[0]?.text, 'café ' + String.fromCharCode(0xfffd));
});

test('#170 untyped binary response preserves original bytes', async () => {
  const result = await callTool('get_untyped', {});
  assert.ok(!result.isError);
  const content = result.content?.[0] as unknown as { type: string; resource: { mimeType: string; blob: string } };
  assert.equal(content.type, 'resource');
  assert.equal(content.resource.mimeType, 'application/octet-stream');
  assert.deepEqual(Buffer.from(content.resource.blob, 'base64'), Buffer.from([0xff, 0, 0x41]));
});
