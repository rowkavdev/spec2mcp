/**
 * OpenAPI 3.1 support: real 3.1 fixtures (Redocly's Museum API), webhooks
 * surfaced as metadata rather than tools, JSON Schema type-union collapse,
 * and jsonSchemaDialect handling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest, DEFAULT_31_DIALECT } from '../src/manifest.js';

const run = promisify(execFile);
const MUSEUM = fileURLToPath(new URL('./fixtures/museum-31.yaml', import.meta.url));
const PETSTORE31 = fileURLToPath(new URL('./fixtures/petstore31.yaml', import.meta.url));
const WEBHOOKS_ONLY = fileURLToPath(new URL('./fixtures/webhooks-only-31.yaml', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

test('real 3.1 spec (Museum API) generates tools and records its webhook', async () => {
  const doc = await loadSpec(MUSEUM);
  await init(doc);
  const m = buildManifest(doc);

  assert.equal(m.specVersion, '3.1.0');
  assert.equal(m.apiTitle, 'Redocly Museum API');
  assert.equal(m.tools.length, 8);
  const names = m.tools.map((t) => t.name);
  for (const n of names) assert.match(n, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.ok(names.includes('get_museum_hours'));
  assert.ok(!names.includes('publish_new_event'), 'webhook is not a tool');

  assert.equal(m.webhooks.length, 1);
  const wh = m.webhooks[0]!;
  assert.equal(wh.name, 'publishNewEvent');
  assert.equal(wh.method, 'POST');
  assert.equal(wh.operationId, 'publishNewEvent');
  assert.equal(wh.description, 'New special event added');

  assert.equal(m.jsonSchemaDialect, undefined, 'no custom dialect declared');
});

test('3.1 type unions collapse to Forge-readable types', async () => {
  const doc = await loadSpec(PETSTORE31);
  await init(doc);
  const m = buildManifest(doc);

  assert.equal(m.specVersion, '3.1.0');
  const getPet = m.tools.find((t) => t.name === 'get_pet');
  assert.ok(getPet);
  // Path params are typed as strings by Forge (they serialise into the URL).
  const petId = getPet.args.find((a) => a.name === 'petId');
  assert.equal(petId?.schema.type, 'string');
  // ["integer", "null"] on a query param collapses to a plain integer argument.
  const verbose = getPet.args.find((a) => a.name === 'verbose');
  assert.equal(verbose?.schema.type, 'number', '["integer", "null"] collapses to a number');
  // Mixed primitive branches survive Forge's adapted string fallback (#150).
  const include = getPet.args.find((a) => a.name === 'include');
  assert.deepEqual(include?.schema, { anyOf: [{ type: 'string' }, { type: 'integer' }], description: 'Extra data to include.' });

  const createPet = m.tools.find((t) => t.name === 'create_pet');
  assert.ok(createPet);
  const nickname = createPet.args.find((a) => a.name === 'nickname');
  // #81: the collapse keeps Forge's adapted view but the argument schema
  // wraps it so input validation admits a valid null.
  assert.deepEqual(nickname?.schema, { anyOf: [{ type: 'string' }, { type: 'null' }] }, '["string", "null"] keeps its null branch');
  const microchip = createPet.args.find((a) => a.name === 'microchipId');
  assert.deepEqual(microchip?.schema, { anyOf: [{ description: 'Optional chip id.', type: 'number' }, { type: 'null' }] }, '#81: nullable integer body property keeps its null branch');
});

test('custom jsonSchemaDialect is recorded on the manifest', async () => {
  const doc = await loadSpec(PETSTORE31);
  await init(doc);
  const m = buildManifest(doc);
  assert.equal(m.jsonSchemaDialect, 'https://dialects.example.com/pets-2020-12');
  assert.notEqual(m.jsonSchemaDialect, DEFAULT_31_DIALECT);
});

test('webhook-only 3.1 spec generates zero tools without crashing', async () => {
  const doc = await loadSpec(WEBHOOKS_ONLY);
  await init(doc);
  const m = buildManifest(doc);
  assert.equal(m.tools.length, 0);
  assert.equal(m.webhooks.length, 3);
  assert.deepEqual(
    m.webhooks.map((w) => w.name),
    ['orderShipped', 'orderCancelled', 'orderReturned'],
  );
  assert.equal(m.webhooks[1]?.operationId, undefined, 'webhook without operationId still recorded');
  assert.equal(m.webhooks[2]?.operationId, 'orderReturned', '#132 referenced path item webhook recorded');
});

test('#132 a referenced webhook path item reaches the generated README', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-webhooks-'));
  try {
    const out = join(dir, 'events-mcp');
    const { stdout } = await run(process.execPath, [TSX, CLI, 'generate', WEBHOOKS_ONLY, '--out', out]);
    assert.match(stdout, /3 webhooks/);
    const readme = await readFile(join(out, 'README.md'), 'utf8');
    assert.match(readme, /## Webhooks/);
    assert.match(readme, /orderReturned/);
    const manifest = JSON.parse(await readFile(join(out, 'operations.json'), 'utf8'));
    assert.equal(manifest.webhooks.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate emits webhook and dialect sections and prints notes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-31-'));
  try {
    const out = join(dir, 'pets31-mcp');
    const { stdout } = await run(process.execPath, [TSX, CLI, 'generate', PETSTORE31, '--out', out]);
    assert.match(stdout, /Generated 2 tools/);
    assert.match(stdout, /1 webhook/);
    assert.match(stdout, /custom JSON Schema dialect/);

    const readme = await readFile(join(out, 'README.md'), 'utf8');
    assert.match(readme, /## Webhooks/);
    assert.match(readme, /petAdopted/);
    assert.match(readme, /not exposed as tools/);
    assert.match(readme, /## JSON Schema dialect/);
    assert.match(readme, /dialects\.example\.com/);

    const manifest = JSON.parse(await readFile(join(out, 'operations.json'), 'utf8'));
    assert.equal(manifest.specVersion, '3.1.0');
    assert.equal(manifest.webhooks.length, 1);
    assert.equal(manifest.jsonSchemaDialect, 'https://dialects.example.com/pets-2020-12');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const NULLABLE31 = fileURLToPath(new URL('./fixtures/nullable-31.yaml', import.meta.url));

test('#81 nullability survives the type-union collapse into the output schema', async () => {
  const doc = await loadSpec(NULLABLE31);
  await init(doc);
  const m = buildManifest(doc);

  const getPet = m.tools.find((t) => t.name === 'get_pet');
  assert.ok(getPet?.outputSchema);
  const props = getPet.outputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(props.tag?.type, ['string', 'null'], 'nullable scalar becomes a type union');
  assert.deepEqual(getPet.outputSchema.required, ['id', 'tag'], 'nullable is not optional');
  assert.deepEqual(
    props.rating?.anyOf,
    [{ type: 'integer' }, { type: 'string' }, { type: 'null' }],
    'multi-type union keeps its null branch',
  );

  // The runtime validator must accept the valid null responses the
  // pre-#81 collapse rejected against the advertised schema.
  const { compileOutputValidator } = (await import(
    new URL('../runtime/server.mjs', import.meta.url).href
  )) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };
  const validate = compileOutputValidator(getPet.outputSchema);
  assert.equal(validate({ id: 'a', tag: null }), true, 'valid null response field');
  assert.equal(validate({ id: 'a', tag: null, rating: null }), true, 'valid null union field');
});

test('#81 nullability survives into the request input schema', async () => {
  const doc = await loadSpec(NULLABLE31);
  await init(doc);
  const m = buildManifest(doc);

  const createPet = m.tools.find((t) => t.name === 'create_pet');
  assert.ok(createPet);
  const nickname = createPet.args.find((a) => a.name === 'nickname');
  assert.equal(nickname?.required, true, 'nullable body property stays required');
  assert.deepEqual(
    (createPet.inputSchema.properties as Record<string, unknown>).nickname,
    { anyOf: [{ type: 'string' }, { type: 'null' }] },
    'input schema admits a valid null',
  );

  // Forge's parameter view stays adapted: the nullable query param is a
  // plain number argument, unchanged by the marker.
  const getPet = m.tools.find((t) => t.name === 'get_pet');
  const verbose = getPet?.args.find((a) => a.name === 'verbose');
  assert.equal(verbose?.schema.type, 'number');
  assert.equal(verbose?.required, false);
});

test('#87 allOf-flattened nullable body property keeps its null branch', async () => {
  const doc = await loadSpec(NULLABLE31);
  await init(doc);
  const m = buildManifest(doc);

  const createOrder = m.tools.find((t) => t.name === 'create_order');
  assert.ok(createOrder);
  const nickname = createOrder.args.find((a) => a.name === 'nickname');
  assert.equal(nickname?.required, true, 'nullable allOf body property stays required');
  assert.deepEqual(
    (createOrder.inputSchema.properties as Record<string, unknown>).nickname,
    { anyOf: [{ type: 'string' }, { type: 'null' }] },
    'nullability survives the allOf flattening',
  );
});

test('#92 a root-nullable response schema wraps under result', async () => {
  const doc = await loadSpec(NULLABLE31);
  await init(doc);
  const m = buildManifest(doc);

  const showPet = m.tools.find((t) => t.name === 'show_pet');
  assert.ok(showPet);
  // MCP advertises one object-shaped schema per tool; a valid JSON null
  // root cannot be structured content, so the nullable schema wraps.
  assert.equal(showPet.outputWrap, true);
  assert.equal(showPet.outputSchema?.type, 'object');
  const result = (showPet.outputSchema?.properties as Record<string, unknown>).result as Record<string, unknown>;
  assert.deepEqual(result?.type, ['object', 'null'], 'null root stays advertised under result');
  assert.deepEqual(showPet.outputSchema?.required, ['result']);

  const { compileOutputValidator } = (await import(
    new URL('../runtime/server.mjs', import.meta.url).href
  )) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };
  const validate = compileOutputValidator(showPet.outputSchema);
  assert.equal(validate({ result: null }), true, 'valid JSON null response');
  assert.equal(validate({ result: { id: 'a' } }), true, 'valid object response');
});

test('#95 oneOf and const root-null response schemas wrap under result', async () => {
  const doc = await loadSpec(NULLABLE31);
  await init(doc);
  const m = buildManifest(doc);

  const { compileOutputValidator } = (await import(
    new URL('../runtime/server.mjs', import.meta.url).href
  )) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };

  const showCat = m.tools.find((t) => t.name === 'show_cat');
  assert.ok(showCat);
  assert.equal(showCat.outputWrap, true, 'oneOf null branch wraps');
  const catResult = (showCat.outputSchema?.properties as Record<string, unknown>).result;
  assert.ok(catResult && typeof catResult === 'object' && 'oneOf' in (catResult as Record<string, unknown>), 'oneOf shape preserved under result');
  const validateCat = compileOutputValidator(showCat.outputSchema);
  assert.equal(validateCat({ result: null }), true, 'valid oneOf null response');
  assert.equal(validateCat({ result: { id: 'c' } }), true, 'valid oneOf object response');

  const showGhost = m.tools.find((t) => t.name === 'show_ghost');
  assert.ok(showGhost);
  assert.equal(showGhost.outputWrap, true, 'const null wraps');
  const validateGhost = compileOutputValidator(showGhost.outputSchema);
  assert.equal(validateGhost({ result: null }), true, 'valid const null response');
  assert.equal(validateGhost({ result: { id: 'g' } }), false, 'non-null still rejected');
});

test('#102 oneOf object|array wraps so a valid root array is not isError', async () => {
  const doc = await loadSpec(NULLABLE31);
  await init(doc);
  const m = buildManifest(doc);

  const showBird = m.tools.find((t) => t.name === 'show_bird');
  assert.ok(showBird);
  assert.equal(showBird.outputWrap, true, 'root array admitted by oneOf wraps');
  const result = (showBird.outputSchema?.properties as Record<string, unknown>).result;
  assert.ok(result && typeof result === 'object' && 'oneOf' in (result as Record<string, unknown>), 'oneOf shape preserved under result');

  const { compileOutputValidator } = (await import(
    new URL('../runtime/server.mjs', import.meta.url).href
  )) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };
  const validate = compileOutputValidator(showBird.outputSchema);
  assert.equal(validate({ result: ['a', 'b'] }), true, 'valid root array response');
  assert.equal(validate({ result: { id: 'b' } }), true, 'valid root object response');
  assert.equal(validate({ result: 42 }), false, 'out-of-contract root still rejected');
});

test('#107 a constrained non-object oneOf branch wraps structurally', async () => {
  const doc = await loadSpec(NULLABLE31);
  await init(doc);
  const m = buildManifest(doc);

  const showFrog = m.tools.find((t) => t.name === 'show_frog');
  assert.ok(showFrog);
  // Finite value probes miss minItems; the branch walk must not.
  assert.equal(showFrog.outputWrap, true, 'oneOf [object, array minItems] wraps');

  const { compileOutputValidator } = (await import(
    new URL('../runtime/server.mjs', import.meta.url).href
  )) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };
  const validate = compileOutputValidator(showFrog.outputSchema);
  assert.equal(validate({ result: ['a', 'b'] }), true, 'valid constrained root array');
  assert.equal(validate({ result: { id: 'f' } }), true, 'valid root object');
  assert.equal(validate({ result: [] }), false, 'constraint still enforced under the wrap');
});

test('#111 the typeless object idiom keeps the OpenAPI object intent', async () => {
  const doc = await loadSpec(NULLABLE31);
  await init(doc);
  const m = buildManifest(doc);

  const showTurtle = m.tools.find((t) => t.name === 'show_turtle');
  assert.ok(showTurtle);
  // Recorded decision (#111): `{properties: ...}` without a type means an
  // object, even though strict 2020-12 admits scalar roots. It advertises
  // directly instead of rewrapping the idiom.
  assert.equal(showTurtle.outputWrap, undefined, 'no rewrap of the typeless idiom');
  assert.equal(showTurtle.outputSchema?.type, 'object');
  const props = showTurtle.outputSchema?.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.id?.type, 'string');
});
