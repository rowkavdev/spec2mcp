/**
 * #63: a tool whose outputSchema Ajv cannot compile (invalid keywords) must
 * not take the server down - the tool is served without structured output
 * and every other tool is unaffected. Covers the original crash: first HTTP
 * initialize POST killing the process inside the async session handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));

const MANIFEST = {
  serverName: 'compile-guard',
  apiTitle: 'Compile Guard',
  apiVersion: '1.0.0',
  specVersion: '3.0.3',
  baseUrl: 'http://127.0.0.1:1',
  auth: { schemes: [], baseUrlEnvVar: 'COMPILE_GUARD_BASE_URL' },
  tools: [
    {
      name: 'good_tool', description: 'healthy', method: 'GET', path: '/good', operationId: 'good',
      args: [], inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    },
    {
      name: 'bad_tool', description: 'invalid regex keyword', method: 'GET', path: '/bad', operationId: 'bad',
      args: [], inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '[' } } },
    },
  ],
};

async function boot(extraArgs: string[]): Promise<{ dir: string; child: ChildProcess }> {
  // Scratch dir inside the repo so server.mjs resolves @modelcontextprotocol/sdk.
  const dir = fileURLToPath(new URL('../.tmp-compile-guard/', import.meta.url));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'operations.json'), JSON.stringify(MANIFEST, null, 2));
  await copyFile(RUNTIME, join(dir, 'server.mjs'));
  const child = spawn(process.execPath, [join(dir, 'server.mjs'), ...extraArgs], {
    env: { ...process.env, PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { dir, child };
}

test('a tool with an uncompilable outputSchema is stripped, not fatal (HTTP initialize)', async () => {
  const { dir, child } = await boot(['--transport', 'http']);
  let log = '';
  try {
    child.stderr!.on('data', (c: Buffer) => { log += c.toString(); });
    const endpoint = await new Promise<URL>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server did not listen: ${log}`)), 10_000);
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${log}`)); });
      const onData = () => {
        const found = log.match(/(http:\/\/127\.0\.0\.1:\d+\/mcp)/);
        if (found) { clearTimeout(timeout); resolve(new URL(found[1]!)); }
      };
      child.stderr!.on('data', onData);
    });
    const client = new Client({ name: 'compile-guard-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const { tools } = await client.listTools();
    const good = tools.find((t) => t.name === 'good_tool');
    const bad = tools.find((t) => t.name === 'bad_tool');
    assert.ok(good?.outputSchema, 'healthy tool keeps its outputSchema');
    assert.ok(bad && !bad.outputSchema, 'uncompilable schema stripped with a warning');
    assert.match(log, /outputSchema failed to compile/);
    await client.close();
    assert.equal(child.exitCode, null, 'server process still alive');
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
