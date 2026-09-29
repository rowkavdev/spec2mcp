import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

const PETSTORE2 = fileURLToPath(new URL('./fixtures/petstore-2.0.json', import.meta.url));
const K8S2 = fileURLToPath(new URL('./fixtures/kubernetes-swagger2.json', import.meta.url));

test('Swagger 2.0 input converts and generates tools', async () => {
  const doc = await loadSpec(PETSTORE2);
  assert.ok(doc.openapi?.startsWith('3.'), 'document is OpenAPI 3.x after conversion');
  await init(doc);
  const m = buildManifest(doc);
  const names = m.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_pet', 'list_pets', 'post_pets'], 'operationIds kept, missing one synthesised');
});

test('host/basePath/schemes become the server URL', async () => {
  const doc = await loadSpec(PETSTORE2);
  assert.equal(doc.servers?.[0]?.url, 'https://api.petstore.test/v1');
});

test('2.0 securityDefinitions map onto existing auth handling', async () => {
  const doc = await loadSpec(PETSTORE2);
  await init(doc);
  const m = buildManifest(doc);
  const byEnv = Object.fromEntries(m.auth.schemes.map((s) => [s.envVar, s]));
  assert.ok(byEnv.PET_STORE_API_KEY, 'apiKey scheme keeps its env var');
  // Root requirement is api_key; getPet overrides with basic auth.
  const getPet = m.tools.find((t) => t.name === 'get_pet');
  assert.ok(getPet, 'get_pet tool exists');
});

test('2.0 basic auth converts to an http basic scheme', async () => {
  const doc = await loadSpec(PETSTORE2);
  const schemes = (doc.components?.securitySchemes ?? {}) as Record<string, { type?: string; scheme?: string }>;
  assert.equal(schemes.basicAuth?.type, 'http');
  assert.equal(schemes.basicAuth?.scheme, 'basic');
});

test('Kubernetes aggregated swagger.json (2.0) converts end to end', async () => {
  const doc = await loadSpec(K8S2);
  await init(doc);
  const m = buildManifest(doc);
  assert.equal(m.tools.length, 1190);
});

test('Swagger 2.0 external relative $refs resolve against the spec, not cwd (#51)', async () => {
  // ./defs.yaml exists next to the spec but not at the process cwd, so a
  // cwd-relative resolution ENOENTs.
  const doc = await loadSpec(fileURLToPath(new URL('./fixtures/swagger2-refs/main.json', import.meta.url)));
  await init(doc);
  const m = buildManifest(doc);
  const tool = m.tools.find((t) => t.name === 'create_widget');
  assert.ok(tool, 'tool generated from the sibling-ref operation');
  assert.ok(tool.args.some((a) => a.name === 'name' || a.name === 'widget'), 'body schema from defs.yaml reached the manifest');
});

test('a document with neither openapi nor swagger keys is rejected', async () => {
  await assert.rejects(loadSpec(fileURLToPath(new URL('./fixtures/compat/expectations.json', import.meta.url))), /OpenAPI 3.x or Swagger 2.0/);
});
