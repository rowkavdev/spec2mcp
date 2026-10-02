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

test('#304 an explicit envPrefix that is not a valid variable name is rejected', () => {
  for (const bad of ['my prefix', '1ABC', 'a-b', '']) {
    assert.throws(() => resolveConfig({}, { envPrefix: bad }), /envPrefix must start with a letter/, bad);
    assert.throws(() => resolveConfig({ envPrefix: bad }, {}), /envPrefix must start with a letter/, bad);
  }
  for (const good of ['MYAPI', 'my_api', '_X', 'A1']) assert.equal(resolveConfig({}, { envPrefix: good }).options.envPrefix, good);
});

test('#306 an explicit baseUrl that is not an absolute http(s) URL is rejected', () => {
  for (const bad of ['not a url', 'ftp://x', 'javascript:alert(1)', '/api']) {
    assert.throws(() => resolveConfig({}, { baseUrl: bad }), /baseUrl must be an absolute http\(s\) URL/, bad);
    assert.throws(() => resolveConfig({ baseUrl: bad }, {}), /baseUrl must be an absolute http\(s\) URL/, bad);
  }
  for (const good of ['https://api.example.com/v1', 'http://127.0.0.1:8080', '']) assert.equal(resolveConfig({}, { baseUrl: good }).options.baseUrl, good);
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

test('#106 suffix allocation never lands on another base name', async () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'R API', version: '1.0.0' },
    servers: [{ url: 'https://r.example.com' }],
    components: {
      schemas: {},
      securitySchemes: {
        // api-key/api_key collide on API_KEY; api_key_2's own base IS the
        // name the naive suffix would hand out.
        'api-key': { type: 'apiKey', in: 'header', name: 'Api-Key' },
        'api_key': { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        'api_key_2': { type: 'apiKey', in: 'header', name: 'X-Secondary-Key' },
        // A scheme normalizing onto the reserved base URL variable.
        'base_url': { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ 'api-key': [], 'api_key': [], 'api_key_2': [], 'base_url': [] }],
    paths: { '/things': { get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } } } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = buildManifest(doc as any);
  const byScheme = new Map(m.auth.schemes.map((s) => [s.schemeName, s.envVar]));
  const envVars = [...byScheme.values()];
  assert.equal(new Set(envVars).size, envVars.length, `duplicate env var emitted: ${envVars.join(', ')}`);
  assert.equal(byScheme.get('api-key'), 'R_API_KEY', 'byte-order first keeps the base name');
  assert.equal(byScheme.get('api_key'), 'R_API_KEY_3', 'suffix skips the taken base name API_KEY_2');
  assert.equal(byScheme.get('api_key_2'), 'R_API_KEY_2', 'own base name stays put');
  assert.equal(byScheme.get('base_url'), 'R_API_BASE_URL_2', 'base URL variable is reserved');
  assert.equal(m.auth.baseUrlEnvVar, 'R_API_BASE_URL');
});

test('#135 referenced security scheme aliases map under their own name and env var', async () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 'R API', version: '1.0.0' },
    servers: [{ url: 'https://r.example.com' }],
    paths: { '/items': { get: {
      operationId: 'listItems',
      security: [{ keyAlias: [] }],
      responses: { '200': { description: 'OK' } },
    } } },
    components: {
      schemas: {},
      securitySchemes: {
        keySource: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        keyAlias: { $ref: '#/components/securitySchemes/keySource' },
        other: { type: 'apiKey', in: 'header', name: 'X-Other' },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = buildManifest(doc as any);
  const names = m.auth.schemes.map((s) => s.schemeName);
  assert.ok(names.includes('keyAlias'), 'alias mapped under its own name');
  assert.deepEqual(m.tools[0]?.authSchemeNames, ['keyAlias']);
  const alias = m.auth.schemes.find((s) => s.schemeName === 'keyAlias');
  const source = m.auth.schemes.find((s) => s.schemeName === 'keySource');
  assert.equal(alias?.kind, 'apikey-header', 'alias inherits the target scheme shape');
  assert.notEqual(alias?.envVar, source?.envVar, 'alias gets its own deterministic env var');
  assert.equal(m.auth.warnings.length, 0, 'no missing-scheme warning');
});

test('#136 an HTTP digest scheme is not silently mapped to bearer', async () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Digest API', version: '1.0.0' },
    servers: [{ url: 'https://digest.example.com' }],
    components: {
      schemas: {},
      securitySchemes: { digestAuth: { type: 'http', scheme: 'digest' } },
    },
    security: [{ digestAuth: [] }],
    paths: { '/': { get: { operationId: 'get', responses: { '200': { description: 'ok' } } } } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = buildManifest(doc as any);
  assert.equal(m.auth.schemes.length, 0, 'digest is not mapped to a static-header scheme');
  assert.ok(
    m.auth.warnings.some((w) => w.includes('digestAuth') && w.includes('unsupported')),
    'a loud generation warning names the unsupported scheme',
  );
  assert.ok(!m.auth.schemes.some((s) => s.kind === 'bearer' && s.schemeName === 'digestAuth'), 'no Bearer header is sent for digest');
});


test('#136 unsupported aliases warn while #146 preserves all usable OR alternatives', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Alternatives', version: '1' },
    components: { schemas: {}, securitySchemes: {
      digest: { type: 'http', scheme: 'digest' },
      digestAlias: { $ref: '#/components/securitySchemes/digest' },
      bearer: { type: 'http', scheme: 'bearer' },
      basic: { type: 'http', scheme: 'basic' },
    } },
    security: [{ digestAlias: [] }, { bearer: [] }, { basic: [] }],
    paths: { '/': { get: { operationId: 'get', responses: { '200': { description: 'ok' } } } } },
  };
  await init(doc as any);
  const m = buildManifest(doc as any);
  assert.deepEqual(m.tools[0]?.authSchemeNames, ['bearer']);
  assert.deepEqual(m.tools[0]?.authAlternatives, [['bearer'], ['basic']]);
  assert.ok(m.auth.warnings.some(w => w.includes('digestAlias') && w.includes('unsupported')));
  assert.deepEqual(m.auth.schemes.map(s => s.schemeName), ['bearer', 'basic']);
});

test('a title that starts with a digit still gives a valid env var name', async () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: '3D Printing API', version: '1.0.0' },
    servers: [{ url: 'https://api.print.test' }],
    security: [{ key: [] }],
    components: { schemas: {}, securitySchemes: { key: { type: 'http', scheme: 'bearer' } } },
    paths: { '/jobs': { get: { operationId: 'listJobs', responses: { '200': { description: 'ok' } } } } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = buildManifest(doc as any);
  assert.match(m.auth.schemes[0]?.envVar ?? '', /^[A-Z_][A-Z0-9_]*$/);
  assert.match(m.auth.baseUrlEnvVar ?? '', /^[A-Z_][A-Z0-9_]*$/);
});
