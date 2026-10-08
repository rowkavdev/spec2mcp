import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as {
  runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server>;
};

for (const mode of ['native', 'throw', 'reject', 'pending'] as const) {
  test(`redirect body cleanup is requested without waiting or masking the error (${mode})`, async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    let upstreamCalls = 0;
    // Only the upstream request is mocked. MCP uses the real SDK and HTTP transport.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith('https://redirect-cleanup.invalid/')) {
        upstreamCalls++;
        assert.equal(init?.redirect, 'manual');
        if (mode === 'native') {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
            cancel() { cancelled = true; },
          });
          return new Response(stream, { status: 307, headers: { location: 'https://never-follow.invalid/' } });
        }
        return {
          status: 307,
          body: { cancel() {
            cancelled = true;
            if (mode === 'throw') throw new Error('cleanup error');
            if (mode === 'reject') return Promise.reject(new Error('cleanup error'));
            return new Promise<void>(() => {});
          } },
        } as unknown as Response;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const client = new Client({ name: 'redirect-cleanup', version: '1' });
    let server: Server | undefined;
    try {
      server = await runHttpServer({
        serverName: 'redirect-cleanup', apiVersion: '1', baseUrl: 'https://redirect-cleanup.invalid',
        auth: { schemes: [] }, tools: [{ name: 'get', operationId: 'get', method: 'GET', path: '/', args: [],
          inputSchema: { type: 'object', properties: {} } }],
      }, { port: 0 });
      const address = server.address() as { port: number };
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      const result = await client.callTool({ name: 'get', arguments: {} }, undefined, { timeout: 2000 });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /HTTP 307 redirect not followed/);
      assert.equal(upstreamCalls, 1, 'the redirect is not followed');
      assert.equal(cancelled, true, 'the rejected redirect body must be cancelled');
    } finally {
      await client.close();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      globalThis.fetch = originalFetch;
    }
  });
}
