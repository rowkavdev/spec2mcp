import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { createMcpTransformer } from '../src/transformer.js';

test('Claude Desktop example escapes the configured server name as JSON', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Demo', version: '1' }, components: { schemas: {} },
    paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'OK' } } } } },
  } as unknown as OpenAPIV3.Document;
  const forge = await init(doc);
  const serverName = 'demo"\\folder\nname';
  const files = await forge.transform(createMcpTransformer(doc, { serverName, runtimeSource: '' }));
  const readme = files.find((file) => file.path === 'README.md')!.content;
  const config = readme.match(/```json\n([\s\S]*?)\n```/)!;
  assert.ok(config, 'Claude Desktop JSON block exists');
  assert.deepEqual(JSON.parse(config[1]!), { mcpServers: { [serverName]: {
    command: 'node', args: ['/absolute/path/to/server.mjs'],
  } } });
});
