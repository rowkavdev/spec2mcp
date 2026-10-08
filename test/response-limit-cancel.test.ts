import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.SPEC2MCP_MAX_RESPONSE_BYTES = '8';
const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server>;
};
delete process.env.SPEC2MCP_MAX_RESPONSE_BYTES;

for (const mode of ['pending', 'throw', 'reject'] as const) {
  test(`oversized response reports its byte limit without waiting for cleanup (${mode})`, async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    let released = false;
    // Upstream reader is mocked; MCP client and HTTP transport are real.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith('https://limit-cancel.invalid/')) return {
        status: 200, ok: true, headers: new Headers({ 'content-type': 'text/plain' }),
        body: { getReader() { return {
          async read() { return { done: false, value: new Uint8Array(9) }; },
          cancel() {
            cancelled = true;
            if (mode === 'throw') throw new Error('cleanup failed');
            if (mode === 'reject') return Promise.reject(new Error('cleanup failed'));
            return new Promise<void>(() => {});
          },
          releaseLock() { released = true; },
        }; } },
      } as unknown as Response;
      return originalFetch(input, init);
    }) as typeof fetch;
    const client = new Client({ name: 'limit-cancel-test', version: '1' });
    let server: Server | undefined;
    try {
      server = await runHttpServer({
        serverName: 'limit-cancel-test', apiVersion: '1', baseUrl: 'https://limit-cancel.invalid',
        auth: { schemes: [] }, tools: [{ name: 'get', operationId: 'get', method: 'GET', path: '/', args: [],
          inputSchema: { type: 'object', properties: {} } }],
      }, { port: 0 });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`)));
      const result = await client.callTool({ name: 'get', arguments: {} }, undefined, { timeout: 500 });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /Response body exceeds the 8 byte limit/);
      assert.equal(cancelled, true);
      assert.equal(released, true);
    } finally {
      await client.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      globalThis.fetch = originalFetch;
    }
  });
}
