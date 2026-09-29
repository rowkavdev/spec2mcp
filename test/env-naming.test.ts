import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';
import { readProjectConfig, resolveConfig } from '../src/config.js';

const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));

test('env var names dedupe prefix/suffix overlap', async () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Cloudflare API', version: '4.0.0' },
    servers: [{ url: 'https://api.cloudflare.test/v4' }],
    security: [{ api_token: [] }],
    components: { schemas: {}, securitySchemes: { api_token: { type: 'http', scheme: 'bearer' } } },
    paths: { '/zones': { get: { operationId: 'listZones', responses: { '200': { description: 'ok' } } } } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = buildManifest(doc as any);
  assert.equal(m.auth.schemes[0]?.envVar, 'CLOUDFLARE_API_TOKEN');
  assert.equal(m.auth.baseUrlEnvVar, 'CLOUDFLARE_API_BASE_URL');
});

test('--env-prefix overrides the derived prefix', async () => {
  await init(await loadSpec(PETSTORE));
  const m = buildManifest(await loadSpec(PETSTORE), { envPrefix: 'MYAPI' });
  assert.equal(m.auth.schemes[0]?.envVar, 'MYAPI_BEARER_AUTH');
  assert.equal(m.auth.baseUrlEnvVar, 'MYAPI_BASE_URL');
});

test('config accepts envPrefix and overlays, flags win over config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-cfg-'));
  try {
    const file = join(dir, 'spec2mcp.config.json');
    await writeFile(file, JSON.stringify({ envPrefix: 'CFG', overlays: ['a.yaml'], include: ['tag:pets'] }));
    const config = await readProjectConfig(file);
    const { options, config: merged } = resolveConfig(config, { overlays: ['b.yaml'] });
    assert.equal(options.envPrefix, 'CFG');
    assert.deepEqual(merged.overlays, ['b.yaml'], 'flag overlays replace config overlays');
    await writeFile(file, JSON.stringify({ bogus: true }));
    await assert.rejects(readProjectConfig(file), /Unknown key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#101 colliding apiKey env names get deterministic suffixes', async () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'R API', version: '1.0.0' },
    servers: [{ url: 'https://r.example.com' }],
    components: {
      schemas: {},
      securitySchemes: {
        // Both names normalize to the same env suffix; the secrets differ.
        'api_key': { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        'api-key': { type: 'apiKey', in: 'header', name: 'Api-Key' },
      },
    },
    security: [{ 'api_key': [], 'api-key': [] }],
    paths: { '/things': { get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } } } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = buildManifest(doc as any);
  const envVars = m.auth.schemes.map((s) => s.envVar).sort();
  assert.deepEqual(envVars, ['R_API_KEY', 'R_API_KEY_2'], 'each header gets its own env var');
  // Deterministic assignment: byte order puts "api-key" first, so it keeps
  // the base name and "api_key" takes the suffix.
  const byScheme = new Map(m.auth.schemes.map((s) => [s.schemeName, s]));
  assert.equal(byScheme.get('api-key')?.envVar, 'R_API_KEY');
  assert.equal(byScheme.get('api_key')?.envVar, 'R_API_KEY_2');
  // Both headers remain configurable on the tool that requires them.
  const tool = m.tools.find((t) => t.name === 'list_things');
  assert.deepEqual(tool?.authSchemeNames?.sort(), ['api-key', 'api_key']);
});
