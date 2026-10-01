import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const MINIMAL = fileURLToPath(new URL('./fixtures/minimal.json', import.meta.url));

test('manifest maps every operation to an MCP-safe tool', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const m = buildManifest(doc);

  assert.equal(m.apiTitle, 'Pet Store');
  assert.equal(m.apiVersion, '1.2.3');
  assert.equal(m.baseUrl, 'https://api.petstore.test/v1');

  const names = m.tools.map((t) => t.name);
  // 7 operations in the fixture (incl. one synthesised id and one deduped duplicate)
  assert.equal(m.tools.length, 7);
  for (const n of names) assert.match(n, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(new Set(names).size, names.length, 'tool names unique');
  assert.ok(names.includes('list_pets'));
  assert.ok(names.includes('list_pets_2'), 'duplicate operationId deduped');
  assert.ok(names.includes('get_legacy'), 'missing operationId synthesised from method+path');
});

test('args carry location, required-ness and JSON schemas', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const m = buildManifest(doc);
  const getPet = m.tools.find((t) => t.name === 'get_pet');
  assert.ok(getPet);
  const petId = getPet.args.find((a) => a.name === 'petId');
  assert.equal(petId?.location, 'path');
  assert.equal(petId?.required, true);
  assert.equal(petId?.schema.type, 'integer', 'Path input keeps its declared type; serialization happens at the wire boundary');
  assert.deepEqual(getPet.inputSchema.required, ['petId']);

  const listPets = m.tools.find((t) => t.name === 'list_pets');
  const limit = listPets?.args.find((a) => a.name === 'limit');
  assert.equal(limit?.location, 'query');
  assert.equal(limit?.required, false);
  assert.equal(limit?.schema.default, 20);
  const tags = listPets?.args.find((a) => a.name === 'tags');
  assert.equal(tags?.schema.type, 'array');
  assert.deepEqual((tags?.schema.items as Record<string, unknown>).enum, ['cat', 'dog', 'fish']);

  const del = m.tools.find((t) => t.name === 'delete_pet');
  const confirm = del?.args.find((a) => a.name === 'X-Confirm');
  assert.equal(confirm?.location, 'header');
  assert.equal(confirm?.required, true);
});

test('nested JSON bodies flatten to dotted args with apiFieldPath', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const m = buildManifest(doc);
  const create = m.tools.find((t) => t.name === 'create_pet');
  assert.ok(create);
  assert.equal(create.contentType, 'application/json');
  const name = create.args.find((a) => a.name === 'name');
  assert.equal(name?.location, 'body');
  assert.equal(name?.required, true, 'name is required at body root');
  const street = create.args.find((a) => a.name === 'address.street');
  assert.deepEqual(street?.apiFieldPath, ['address', 'street']);
  assert.equal(street?.required, false, 'address itself is optional at root');
});

test('non-JSON bodies fall back to a single raw body arg', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const m = buildManifest(doc);
  const upload = m.tools.find((t) => t.name === 'upload_file');
  assert.ok(upload);
  assert.equal(upload.args.length, 1);
  assert.equal(upload.args[0]?.name, 'body');
  assert.equal(upload.contentType, 'application/octet-stream');
});

test('auth plan maps bearer scheme to an env var', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const m = buildManifest(doc);
  assert.equal(m.auth.schemes.length, 1, 'only the root requirement is used by this fixture');
  assert.equal(m.auth.schemes[0]?.kind, 'bearer');
  assert.equal(m.auth.schemes[0]?.envVar, 'PET_STORE_BEARER_AUTH');
  assert.equal(m.auth.baseUrlEnvVar, 'PET_STORE_BASE_URL');
});

test('spec without servers or security yields empty auth and no base URL', async () => {
  const doc = await loadSpec(MINIMAL);
  await init(doc);
  const m = buildManifest(doc);
  assert.equal(m.baseUrl, '');
  assert.equal(m.auth.schemes.length, 0);
  assert.equal(m.tools.length, 1);
  assert.equal(m.tools[0]?.name, 'get_status');
});


test('operation security overrides root, including explicit anonymous and missing schemes', async () => {
  const doc = await loadSpec(PETSTORE);
  doc.paths['/pets']!.get!.security = [];
  doc.paths['/pets']!.post!.security = [{ apiKeyQuery: [] }];
  doc.paths['/pets/{petId}']!.delete!.security = [{ missingAuth: [] }];
  await init(doc);
  const m = buildManifest(doc);
  const tool = (name: string) => m.tools.find((t) => t.name === name);
  assert.deepEqual(tool('list_pets')?.authSchemeNames, []);
  assert.deepEqual(tool('create_pet')?.authSchemeNames, ['apiKeyQuery']);
  assert.deepEqual(tool('get_pet')?.authSchemeNames, ['bearerAuth']);
  assert.deepEqual(tool('delete_pet')?.authSchemeNames, [], 'unresolved scheme must not leak root credentials');
  assert.deepEqual(m.auth.schemes.map((s) => s.schemeName), ['apiKeyQuery', 'bearerAuth']);
  assert.match(m.auth.warnings.join('\n'), /DELETE \/pets\/\{petId\}.*missingAuth.*continuing without it/);
});

test('single usable scheme is fallback for missing declaration or missing referenced scheme', async () => {
  const doc = await loadSpec(PETSTORE);
  delete doc.security;
  delete doc.components!.securitySchemes!.apiKeyQuery;
  doc.paths['/pets']!.post!.security = [{ nonexistent: [] }];
  doc.paths['/pets/{petId}']!.get!.security = [];
  await init(doc);
  const m = buildManifest(doc);
  assert.deepEqual(m.tools.find((t) => t.name === 'list_pets')?.authSchemeNames, ['bearerAuth']);
  assert.deepEqual(m.tools.find((t) => t.name === 'create_pet')?.authSchemeNames, ['bearerAuth']);
  assert.deepEqual(m.tools.find((t) => t.name === 'get_pet')?.authSchemeNames, []);
  assert.match(m.auth.warnings.join('\n'), /nonexistent.*using "bearerAuth"/);
});


test('AND schemes combine, and a valid OR alternative wins over an unresolved one', async () => {
  const doc = await loadSpec(PETSTORE);
  doc.paths['/pets']!.get!.security = [{ bearerAuth: [], apiKeyQuery: [] }];
  doc.paths['/pets']!.post!.security = [{ missingAuth: [] }, { apiKeyQuery: [] }];
  await init(doc);
  const m = buildManifest(doc);
  assert.deepEqual(m.tools.find((t) => t.name === 'list_pets')?.authSchemeNames, ['bearerAuth', 'apiKeyQuery']);
  assert.deepEqual(m.tools.find((t) => t.name === 'create_pet')?.authSchemeNames, ['apiKeyQuery']);
  assert.deepEqual(m.auth.warnings, []);
});

test('operations with a declared JSON response schema get an MCP outputSchema', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const m = buildManifest(doc);

  const getPet = m.tools.find((t) => t.name === 'get_pet');
  assert.ok(getPet?.outputSchema, 'object response -> outputSchema');
  assert.equal(getPet.outputWrap, undefined);
  assert.equal(getPet.outputSchema.type, 'object');
  const props = getPet.outputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.id?.type, 'integer');
  assert.deepEqual(props.tag?.type, ['string', 'null'], 'nullable becomes a type union');
  // Nested $refs are fully dereferenced: Pet.owner -> Owner -> Owner.pets.items -> Pet (cycle)
  const owner = props.owner as Record<string, unknown>;
  assert.equal(owner.type, 'object');
  const ownerProps = owner.properties as Record<string, Record<string, unknown>>;
  const petsItems = (ownerProps.pets?.items ?? {}) as Record<string, unknown>;
  assert.equal(petsItems.type, 'object', 'cyclic ref resolved once');
  const cyclicOwner = (petsItems.properties as Record<string, unknown>).owner;
  assert.deepEqual(cyclicOwner, {}, 'cycle collapses to an open schema instead of recursing forever');

  const createPet = m.tools.find((t) => t.name === 'create_pet');
  assert.equal(createPet?.outputSchema?.type, 'object', 'non-200 2xx schemas are picked up too');

  const listPets = m.tools.find((t) => t.name === 'list_pets');
  assert.equal(listPets?.outputWrap, true, 'array body is wrapped for MCP object compliance');
  assert.deepEqual(listPets?.outputSchema?.required, ['result']);
  const result = (listPets?.outputSchema?.properties as Record<string, Record<string, unknown>>).result;
  assert.equal(result?.type, 'array');
  assert.equal((result?.items as Record<string, unknown>).type, 'object');
});

test('operations without a declared JSON response schema stay text-only', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const m = buildManifest(doc);
  for (const name of ['get_legacy', 'upload_file', 'delete_pet']) {
    const tool = m.tools.find((t) => t.name === name);
    assert.equal(tool?.outputSchema, undefined, `${name} has no outputSchema`);
    assert.equal(tool?.outputWrap, undefined);
  }
});

const MEDIA = fileURLToPath(new URL('./fixtures/media.yaml', import.meta.url));

test('multipart bodies become per-field args, files marked binary', async () => {
  const doc = await loadSpec(MEDIA);
  await init(doc);
  const m = buildManifest(doc);
  const upload = m.tools.find((t) => t.name === 'upload_pet_photo');
  assert.ok(upload);
  assert.equal(upload.contentType, 'multipart/form-data');

  const photo = upload.args.find((a) => a.name === 'photo');
  assert.equal(photo?.location, 'body');
  assert.equal(photo?.binary, true);
  assert.equal(photo?.required, true);
  assert.equal(photo?.schema.type, 'object');
  assert.deepEqual(photo?.schema.required, ['contentBase64']);
  const photoProps = photo?.schema.properties as Record<string, Record<string, unknown>>;
  assert.ok(photoProps.contentBase64);
  assert.ok(photoProps.filename);
  assert.ok(photoProps.mimeType);

  const caption = upload.args.find((a) => a.name === 'caption');
  assert.equal(caption?.binary, undefined);
  assert.equal(caption?.schema.type, 'string');
  assert.equal(caption?.required, false);
  const isPublic = upload.args.find((a) => a.name === 'isPublic');
  assert.equal(isPublic?.schema.type, 'boolean');
  const labels = upload.args.find((a) => a.name === 'labels');
  assert.equal(labels?.schema.type, 'array');
  const metadata = upload.args.find((a) => a.name === 'metadata');
  assert.equal(metadata?.schema.type, 'object');

  assert.deepEqual(upload.inputSchema.required, ['petId', 'photo']);
});

test('tools record their declared success response content types', async () => {
  const doc = await loadSpec(MEDIA);
  await init(doc);
  const m = buildManifest(doc);
  assert.deepEqual(m.tools.find((t) => t.name === 'get_pet_photo')?.responseContentTypes, ['image/png']);
  assert.deepEqual(m.tools.find((t) => t.name === 'get_pet_records')?.responseContentTypes, ['application/pdf']);
  assert.deepEqual(m.tools.find((t) => t.name === 'export_pets')?.responseContentTypes, ['text/csv']);
  assert.deepEqual(m.tools.find((t) => t.name === 'upload_pet_photo')?.responseContentTypes, ['application/json']);
});

test('operations with undeclared response bodies have no response content types', async () => {
  const doc = await loadSpec(PETSTORE);
  await init(doc);
  const m = buildManifest(doc);
  const getPet = m.tools.find((t) => t.name === 'get_legacy');
  assert.equal(getPet?.responseContentTypes, undefined);
});

test('#88 a 3.0.x body property typed as a union is collapsed, not dropped', async () => {
  const doc = await loadSpec(fileURLToPath(new URL('./fixtures/union-30.yaml', import.meta.url)));
  await init(doc);
  const m = buildManifest(doc);

  const createPet = m.tools.find((t) => t.name === 'create_pet');
  assert.ok(createPet);
  const nickname = createPet.args.find((a) => a.name === 'nickname');
  assert.ok(nickname, 'union-typed required field must not vanish from the manifest');
  assert.equal(nickname.required, true);
  assert.deepEqual(
    (createPet.inputSchema.properties as Record<string, unknown>).nickname,
    { anyOf: [{ type: 'string' }, { type: 'null' }] },
    'off-spec union normalizes to the #81 nullable form',
  );
});

test('#96 an escaped-key $ref resolves instead of collapsing to an open object', async () => {
  const doc = await loadSpec(fileURLToPath(new URL('./fixtures/escaped-keys.yaml', import.meta.url)));
  await init(doc);
  const m = buildManifest(doc);

  const getPet = m.tools.find((t) => t.name === 'get_pet');
  assert.ok(getPet?.outputSchema);
  const props = getPet.outputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  assert.ok(props, 'escaped component key must not collapse to an empty schema');
  assert.equal(props.id?.type, 'string');
  assert.equal(props.name?.type, 'string');
  assert.deepEqual(getPet.outputSchema.required, ['id']);
});

test('#112 an escaped $ref below the component key resolves via hoisting', async () => {
  const doc = await loadSpec(fileURLToPath(new URL('./fixtures/escaped-keys.yaml', import.meta.url)));
  await init(doc);
  const m = buildManifest(doc);

  const getDeep = m.tools.find((t) => t.name === 'get_deep');
  assert.ok(getDeep?.outputSchema);
  const props = getDeep.outputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  assert.ok(props, 'deep escaped ref must not collapse to an empty schema');
  assert.equal(props.code?.type, 'string');
  assert.deepEqual(getDeep.outputSchema.required, ['code']);
});

test('#112 an unresolvable $ref stays text-only and warns loudly', async () => {
  // A ref the loader cannot reach (inline docs skip loadSpec's bundler,
  // which rejects dangling pointers outright).
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Dangling API', version: '1.0.0' },
    servers: [{ url: 'https://dangling.example.com' }],
    paths: {
      '/things': {
        get: {
          operationId: 'getThing',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } },
            },
          },
        },
      },
    },
    components: { schemas: {} },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = buildManifest(doc as any);

  const getThing = m.tools.find((t) => t.name === 'get_thing');
  assert.ok(getThing);
  assert.equal(getThing.outputSchema, undefined, 'never advertise the empty collapse');
  assert.ok(
    m.warnings?.some((w) => w.includes('#/components/schemas/Missing') && w.includes('get_thing')),
    `expected a loud warning, got: ${(m.warnings ?? []).join(' | ')}`,
  );
});

test('#115 a __proto__ field name survives into input and output schemas', async () => {
  // Parsed, not a literal: object literals treat __proto__ as the
  // prototype, while JSON.parse (like the loader) creates an own key.
  const doc = JSON.parse(`{
    "openapi": "3.0.3",
    "info": { "title": "Proto API", "version": "1.0.0" },
    "servers": [{ "url": "https://proto.example.com" }],
    "paths": {
      "/things": {
        "post": {
          "operationId": "makeThing",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": ["__proto__"],
                  "properties": { "__proto__": { "type": "string" }, "name": { "type": "string" } }
                }
              }
            }
          },
          "responses": {
            "200": {
              "description": "ok",
              "content": {
                "application/json": {
                  "schema": { "type": "object", "properties": { "__proto__": { "type": "string" }, "id": { "type": "string" } } }
                }
              }
            }
          }
        }
      }
    },
    "components": { "schemas": {} }
  }`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = buildManifest(doc as any);

  const tool = m.tools.find((t) => t.name === 'make_thing');
  assert.ok(tool);
  assert.ok(Object.hasOwn(tool.inputSchema.properties as object, '__proto__'), 'input field must not vanish');
  assert.deepEqual(tool.inputSchema.required, ['__proto__'], 'required preserved');
  const outProps = tool.outputSchema?.properties as Record<string, unknown>;
  assert.ok(Object.hasOwn(outProps, '__proto__'), 'output field must not vanish');
  // Own enumerable: the field serializes into the generated manifest.
  assert.ok(JSON.stringify(tool.inputSchema.properties).includes('__proto__'));
});

test('#149 OpenAPI 3.1 response $ref siblings survive in outputSchema', async () => {
  const doc = await loadSpec(fileURLToPath(new URL('./fixtures/ref-siblings-31.json', import.meta.url)));
  await init(doc);
  const schema = buildManifest(doc).tools.find((t) => t.name === 'get_x')?.outputSchema;
  assert.ok(schema);
  assert.equal(schema.type, 'object');
  const branches = schema.allOf as Record<string, unknown>[];
  assert.equal(branches.length, 2, 'both referenced and sibling constraints must apply');
  assert.deepEqual(branches[0]?.required, ['id']);
  assert.deepEqual(branches[1]?.required, ['id', 'name']);
  assert.equal((branches[0]?.properties as Record<string, Record<string, unknown>>).id?.type, 'integer');
  assert.equal((branches[1]?.properties as Record<string, Record<string, unknown>>).name?.type, 'string');
});
test('#153 required boolean-array body field is represented beside scalar siblings', async () => {
  const doc = await loadSpec(fileURLToPath(new URL('./fixtures/boolean-array-body.json', import.meta.url)));
  await init(doc);
  const tool = buildManifest(doc).tools.find((t) => t.name === 'post_x');
  assert.ok(tool);
  assert.ok(tool.args.some((a) => a.name === 'name'));
  const flags = tool.args.find((a) => a.name === 'flags');
  assert.ok(flags, 'required array must not disappear because name was extracted');
  assert.equal(flags.required, true);
  assert.deepEqual(flags.schema, { type: 'array', items: { type: 'boolean' } });
  assert.ok((tool.inputSchema.required as string[]).includes('flags'));
});
test('#150 mixed-type oneOf query preserves both declared input branches', async () => {
  const doc = await loadSpec(fileURLToPath(new URL('./fixtures/mixed-union-parameter-31.json', import.meta.url)));
  await init(doc);
  const tool = buildManifest(doc).tools.find((t) => t.name === 'get_items');
  assert.ok(tool);
  assert.deepEqual(tool.args.find((a) => a.name === 'key')?.schema, { oneOf: [{ type: 'integer' }, { type: 'string' }] });
  assert.deepEqual((tool.inputSchema.properties as Record<string, unknown>).key, { oneOf: [{ type: 'integer' }, { type: 'string' }] });
});

test('#153 unsupported required body field uses a whole-body contract, not partial fields', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Coverage', version: '1' },
    paths: { '/x': { post: { operationId: 'postX', requestBody: {
      required: true, content: { 'application/json': { schema: { type: 'object',
        required: ['matrix'], properties: { name: { type: 'string' }, matrix: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } },
      } } },
    }, responses: { '204': { description: 'OK' } } } } },
    components: { schemas: {} },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildManifest(doc as any).tools.find((t) => t.name === 'post_x');
  assert.ok(tool);
  assert.deepEqual(tool.args.map((a) => a.name), ['body']);
  assert.deepEqual(tool.inputSchema.required, ['body']);
  assert.deepEqual(tool.args[0]?.schema, { type: 'object', required: ['matrix'], properties: {
    name: { type: 'string' }, matrix: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
  } });
});

test('#178 reserved header Parameter Objects are ignored, including required flags', async () => {
  const headers = ['Accept', 'content-type', 'AUTHORIZATION'];
  const params = [
    ...headers.map((name) => ({ name, in: 'header', required: true, schema: { type: 'string' } })),
    { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' } },
  ];
  const doc = { openapi: '3.0.3', info: { title: 'Headers', version: '1' }, components: { schemas: {} },
    paths: { '/': { get: { operationId: 'getX', parameters: params,
      responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
    } } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildManifest(doc as any).tools.find((t) => t.name === 'get_x');
  assert.ok(tool);
  assert.deepEqual(tool.args.map((arg) => arg.name), ['X-Trace']);
  assert.deepEqual(tool.inputSchema.required, ['X-Trace']);
  assert.deepEqual(tool.responseContentTypes, ['application/json']);
});

test('#176 urlencoded encoding.headers is ignored without disabling the form field', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Form', version: '1' }, components: { schemas: {} }, paths: {
    '/': { post: { operationId: 'postForm', requestBody: { required: true, content: {
      'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { name: { type: 'string' } } },
        encoding: { name: { style: 'form', explode: true, headers: { 'X-Test': { schema: { type: 'string' } } } } } },
    } }, responses: { '200': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildManifest(doc as any).tools.find((t) => t.name === 'post_form');
  assert.ok(tool);
  assert.deepEqual(tool.formEncoding, { name: { style: 'form', explode: true } });
});
test('#177 required readOnly multipart property is output-only and absent from upload args', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Files', version: '1' }, components: { schemas: {} }, paths: {
    '/photos': { post: { operationId: 'uploadPhotos', requestBody: { required: true, content: {
      'multipart/form-data': { schema: { type: 'object', required: ['photo', 'id'], properties: {
        photo: { type: 'string', format: 'binary' }, id: { type: 'string', readOnly: true },
      } } },
    } }, responses: { '200': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildManifest(doc as any).tools.find((t) => t.name === 'upload_photos');
  assert.ok(tool);
  assert.deepEqual(tool.args.map((a) => a.name), ['photo']);
  assert.deepEqual(tool.inputSchema.required, ['photo']);
  assert.equal(tool.args[0]?.binary, true);
});

test('#173 +json request body keeps declared fields rather than a raw escape hatch', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Patch', version: '1' }, components: { schemas: {} }, paths: {
    '/': { patch: { operationId: 'patchThing', requestBody: { required: true, content: {
      'application/merge-patch+json': { schema: { type: 'object', required: ['name'], properties: {
        name: { type: 'string' }, nickname: { type: 'string', nullable: true },
      } } },
    } }, responses: { '200': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildManifest(doc as any).tools.find((t) => t.name === 'patch_thing');
  assert.ok(tool);
  assert.equal(tool.contentType, 'application/merge-patch+json');
  assert.deepEqual(tool.args.map((a) => a.name), ['name', 'nickname']);
  assert.deepEqual(tool.inputSchema.required, ['name']);
  assert.deepEqual(tool.args[1]?.schema, { anyOf: [{ type: 'string' }, { type: 'null' }] });
});
test('#173 +json body with an unflattenable required property falls back to a whole-body contract', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'PatchMatrix', version: '1' }, components: { schemas: {} }, paths: {
    '/': { patch: { operationId: 'patchMatrix', requestBody: { required: true, content: {
      'application/merge-patch+json': { schema: { type: 'object', required: ['matrix'], properties: {
        name: { type: 'string' }, matrix: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
      } } },
    } }, responses: { '200': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildManifest(doc as any).tools.find((t) => t.name === 'patch_matrix');
  assert.ok(tool);
  assert.deepEqual(tool.args.map((a) => a.name), ['body']);
  assert.deepEqual(tool.inputSchema.required, ['body']);
  assert.deepEqual(tool.args[0]?.schema, { type: 'object', required: ['matrix'], properties: {
    name: { type: 'string' }, matrix: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
  } });
});

test('#150 nullable mixed primitive query parameter preserves its null branch', async () => {
  const doc = { openapi: '3.1.0', info: { title: 'Nullable', version: '1' }, components: { schemas: {} }, paths: {
    '/x': { get: { operationId: 'getX', parameters: [{ name: 'key', in: 'query', required: true,
      schema: { oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] } }],
      responses: { '204': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = buildManifest(doc as any).tools.find((t) => t.name === 'get_x')?.args.find((a) => a.name === 'key')?.schema;
  assert.deepEqual(schema, { oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] });
});
test('#150 array query parameter preserves mixed item branches', async () => {
  const doc = { openapi: '3.1.0', info: { title: 'Array', version: '1' }, components: { schemas: {} }, paths: {
    '/x': { get: { operationId: 'getX', parameters: [{ name: 'keys', in: 'query', required: true,
      schema: { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'string' }] } } }],
      responses: { '204': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = buildManifest(doc as any).tools.find((t) => t.name === 'get_x')?.args.find((a) => a.name === 'keys')?.schema;
  assert.deepEqual(schema, { type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'string' }] } });
});

test('#154 top-level array body retains item and length constraints', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Array', version: '1' }, components: { schemas: {} }, paths: {
    '/x': { post: { operationId: 'postX', requestBody: { required: true, content: { 'application/json': { schema:
      { type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer', minimum: 1 } },
    } } }, responses: { '204': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildManifest(doc as any).tools.find((t) => t.name === 'post_x');
  assert.ok(tool);
  assert.deepEqual(tool.args[0]?.schema, { type: 'array', minItems: 1, maxItems: 3,
    items: { type: 'integer', minimum: 1 }, description: 'Request body (JSON array).' });
});
test('top-level primitive JSON body retains minimum and type in input contract', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'Number', version: '1' }, components: { schemas: {} }, paths: {
    '/x': { post: { operationId: 'postX', requestBody: { required: true, content: { 'application/json': { schema: { type: 'number', minimum: 2 } } } },
      responses: { '204': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildManifest(doc as any).tools.find((t) => t.name === 'post_x');
  assert.ok(tool);
  assert.deepEqual(tool.args, [{ name: 'body', location: 'body', apiFieldPath: [], required: true,
    schema: { type: 'number', minimum: 2, description: 'Raw request body.' } }]);
});

test('top-level referenced primitive body retains OpenAPI 3.1 ref sibling constraints', async () => {
  const doc = { openapi: '3.1.0', info: { title: 'Score', version: '1' }, components: { schemas: {
    Score: { type: 'integer', minimum: 0 },
  } }, paths: {
    '/score': { post: { operationId: 'postScore', requestBody: { required: true, content: {
      'application/json': { schema: { $ref: '#/components/schemas/Score', maximum: 10 } },
    } }, responses: { '204': { description: 'OK' } } } },
  } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await init(doc as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = buildManifest(doc as any).tools.find((t) => t.name === 'post_score')?.args.find((a) => a.name === 'body')?.schema;
  assert.deepEqual(schema, { allOf: [{ type: 'integer', minimum: 0 }, { maximum: 10 }], description: 'Raw request body.' });
});

test('#138 an operation cookie parameter replaces the inherited path-item one', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Cookies', version: '1' },
    components: { schemas: {} },
    paths: {
      '/account': {
        parameters: [{ name: 'session', in: 'cookie', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'getAccount',
          parameters: [{ name: 'session', in: 'cookie', required: false, schema: { type: 'integer' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  } as never;
  await init(doc);
  const m = buildManifest(doc);
  const tool = m.tools.find((t) => t.operationId === 'getAccount');
  const sessionArgs = tool?.args.filter((a) => (a.apiName ?? a.name) === 'session') ?? [];
  assert.equal(sessionArgs.length, 1, 'the operation parameter replaces the inherited one');
  assert.equal(sessionArgs[0]?.name, 'session', 'no disambiguation suffix when the override wins');
  assert.equal(sessionArgs[0]?.location, 'cookie');
  assert.equal(sessionArgs[0]?.required, false, 'the overriding optional parameter drops the inherited requirement');
  assert.equal(sessionArgs[0]?.schema.type, 'integer');
});

test('#152 an undeclared path placeholder becomes a required argument with a warning', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Items', version: '1' },
    components: { schemas: {} },
    paths: {
      '/items/{id}': { get: { operationId: 'getItem', responses: { '200': { description: 'OK' } } } },
      '/things/{name}': { get: {
        operationId: 'getThing',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      } },
    },
  } as never;
  await init(doc);
  const m = buildManifest(doc);
  const getItem = m.tools.find((t) => t.operationId === 'getItem');
  const id = getItem?.args.find((a) => a.name === 'id');
  assert.ok(id, 'undeclared placeholder is exposed as an argument');
  assert.equal(id.location, 'path');
  assert.equal(id.required, true, 'a path placeholder is always required');
  assert.deepEqual(id.schema, { type: 'string' });
  assert.ok(
    (m.warnings ?? []).some((w) => w.includes('"id"') && w.includes('not declared')),
    'the synthesis is loud',
  );
  const getThing = m.tools.find((t) => t.operationId === 'getThing');
  assert.equal(getThing?.args.filter((a) => a.location === 'path').length, 1, 'a declared placeholder is not duplicated');
  assert.ok(!(m.warnings ?? []).some((w) => w.includes('"name"')), 'no warning for a declared placeholder');
});

test('#211 a declared path parameter with no matching placeholder warns', async () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Items', version: '1' },
    components: { schemas: {} },
    paths: {
      '/items/{id}': { get: {
        operationId: 'getItem',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ghost', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      } },
    },
  } as never;
  await init(doc);
  const m = buildManifest(doc);
  const tool = m.tools.find((t) => t.operationId === 'getItem');
  assert.ok(tool?.args.some((a) => a.name === 'ghost' && a.location === 'path'), 'the declared parameter stays an argument');
  assert.ok((m.warnings ?? []).some((w) => w.includes('"ghost"') && w.includes('no matching placeholder')), 'the dead parameter is surfaced');
  assert.ok(!(m.warnings ?? []).some((w) => w.includes('"id"') && w.includes('no matching placeholder')), 'a matched placeholder stays quiet');
});
