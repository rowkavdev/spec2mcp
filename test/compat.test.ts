/**
 * Real-spec compat matrix: pinned snapshots of four large public APIs
 * (Stripe, Kubernetes, Spotify, Vercel) under test/fixtures/compat. Each
 * spec must load, generate the exact recorded tool count, produce
 * well-formed tools, and emit a complete project. Snapshots and counts are
 * refreshed from the live sources with `npm run compat:refresh` (network,
 * not part of CI); the suite itself runs offline in CI.
 *
 * Spotify's official spec references an external file ('../policies.yaml'),
 * which is why its snapshot lives in a subdirectory next to policies.yaml:
 * loading it also proves external $ref bundling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest, type Manifest } from '../src/manifest.js';
import { createMcpTransformer } from '../src/transformer.js';

const DIR = fileURLToPath(new URL('./fixtures/compat/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../runtime/server.mjs', import.meta.url));

type Expectation = { id: string; title: string; file: string; url: string; openapi: string; tools: number };
const expectations: { refreshed: string; specs: Expectation[] } = JSON.parse(
  await readFile(new URL('./fixtures/compat/expectations.json', import.meta.url), 'utf8'),
);

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function assertToolShape(m: Manifest): void {
  const names = m.tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names unique');
  for (const t of m.tools) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/, `MCP-safe tool name: ${t.name}`);
    assert.ok(t.description.length > 0, `${t.name} has a description`);
    assert.ok(HTTP_METHODS.has(t.method), `${t.name} has an indexable HTTP method (${t.method})`);
    assert.ok(t.path.startsWith('/'), `${t.name} path is absolute`);
    assert.equal(t.operationId.length > 0, true, `${t.name} keeps an operationId`);

    const schema = t.inputSchema;
    assert.equal(schema.type, 'object', `${t.name} input schema is an object`);
    const properties = schema.properties as Record<string, unknown>;
    const required = schema.required as string[];
    assert.ok(properties && typeof properties === 'object', `${t.name} has properties`);
    assert.ok(Array.isArray(required), `${t.name} has a required list`);
    for (const r of required) assert.ok(r in properties, `${t.name}: required arg "${r}" exists in properties`);
    assert.equal(Object.keys(properties).length, t.args.length, `${t.name}: every arg is in the input schema`);

    for (const a of t.args) {
      assert.ok(['path', 'query', 'header', 'body'].includes(a.location), `${t.name}.${a.name} has a location`);
      if (a.location === 'path') assert.equal(a.required, true, `${t.name}.${a.name}: path params are required`);
      if (a.location === 'body') assert.ok(Array.isArray(a.apiFieldPath), `${t.name}.${a.name}: body args carry apiFieldPath`);
    }
    if (t.args.some((a) => a.location === 'body')) {
      assert.ok(t.contentType, `${t.name}: body arguments imply a content type`);
    }
  }
}

for (const spec of expectations.specs) {
  test(`compat: ${spec.id} (${spec.title})`, async () => {
    const doc = await loadSpec(`${DIR}${spec.file}`);
    const forge = await init(doc);
    const m = buildManifest(doc);

    assert.equal(m.apiTitle, spec.title);
    assert.equal(m.specVersion, spec.openapi);
    assert.equal(m.tools.length, spec.tools, `${spec.id} tool count drifted - refresh snapshots with npm run compat:refresh if the API genuinely changed`);
    assertToolShape(m);

    // Full project generation through the Forge transformer.
    const runtimeSource = await readFile(RUNTIME, 'utf8');
    const files = await forge.transform(createMcpTransformer(doc, { runtimeSource }));
    assert.deepEqual(
      files.map((f) => f.path),
      ['operations.json', 'spec2mcp.config.json', 'server.mjs', 'package.json', 'README.md', '.env.example', '.gitignore'],
    );
    const emitted = JSON.parse(files.find((f) => f.path === 'operations.json')!.content) as Manifest;
    assert.equal(emitted.tools.length, spec.tools);
    assert.equal(files.find((f) => f.path === 'server.mjs')!.content, runtimeSource);
    const pkg = JSON.parse(files.find((f) => f.path === 'package.json')!.content);
    assert.ok(pkg.dependencies['@modelcontextprotocol/sdk'], 'generated project depends only on the MCP SDK');
    assert.deepEqual(Object.keys(pkg.dependencies), ['@modelcontextprotocol/sdk']);
    assert.match(files.find((f) => f.path === 'README.md')!.content, /\| Tool \| HTTP \| Description \|/);
  });
}
