import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

test('escaped security scheme names remain bound to root and operation requirements', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-security-key-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(path, JSON.stringify({ openapi: '3.0.3', info: { title: 'Auth keys', version: '1' },
      security: [{ 'a/b': [] }], components: { securitySchemes: {
        'a/b': { type: 'http', scheme: 'bearer' },
        'a~b': { type: 'apiKey', in: 'header', name: 'X-Key' },
        a_b: { type: 'http', scheme: 'basic' },
      } }, paths: {
        '/root': { get: { operationId: 'root', responses: { '200': { description: 'ok' } } } },
        '/override': { get: { operationId: 'override', security: [{ 'a~b': [], 'a/b': [] }], responses: { '200': { description: 'ok' } } } },
        '/anonymous': { get: { operationId: 'anonymous', security: [], responses: { '200': { description: 'ok' } } } },
      } }));
    const doc = await loadSpec(path);
    await init(doc);
    const manifest = buildManifest(doc);
    const names = (operationId: string) => manifest.tools.find(t => t.operationId === operationId)!.authSchemeNames!;
    assert.deepEqual(names('root'), ['a/b']);
    assert.deepEqual(names('override'), ['a~b', 'a/b']);
    assert.deepEqual(names('anonymous'), []);
    assert.deepEqual(manifest.auth.warnings, []);
    const rootScheme = manifest.auth.schemes.find(s => s.schemeName === names('root')[0]);
    assert.equal(rootScheme?.kind, 'bearer');
    assert.equal(manifest.auth.schemes.find(s => s.schemeName === names('override')[0])?.kind, 'apikey-header');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
