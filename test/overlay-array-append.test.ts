import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import type { ApiOverlayFile } from '../vendor/forge/index.js';
import { applyOverlays } from '../src/overlay.js';
const overlays = (actions: unknown[]) => [{ name: 'append', overlay: { overlay: '1.0.0', info: { title: 'append', version: '1' }, actions } }] as ApiOverlayFile[];
test('Overlay 1.0 array-target example appends a query parameter', () => {
 const doc = { openapi: '3.1.0', info: { title: 'API', version: '1' }, paths: { '/': { get: { parameters: [], responses: { '200': { description: 'ok' } } } } } } as OpenAPIV3.Document;
 applyOverlays(doc, overlays([{ target: '$.paths.*.get.parameters', update: { name: 'newParam', in: 'query', schema: { type: 'string' } } }]));
 assert.deepEqual(doc.paths['/']!.get!.parameters, [{ name: 'newParam', in: 'query', schema: { type: 'string' } }]);
});

for (const update of [null, 3, true, 'new', ['nested', 1], { child: { value: 1 } }]) {
 test(`array target appends one cloned entry: ${JSON.stringify(update)}`, () => {
  const doc = { 'x-arrays': [[1], []] } as unknown as OpenAPIV3.Document;
  applyOverlays(doc, overlays([{ target: "$['x-arrays'][*]", update }]));
  assert.deepEqual((doc as any)['x-arrays'], [[1, update], [update]]);
  if (update && typeof update === 'object') {
   assert.notEqual((doc as any)['x-arrays'][0][1], update);
   assert.notEqual((doc as any)['x-arrays'][0][1], (doc as any)['x-arrays'][1][0]);
  }
 });
}
test('mixed object and array targets merge and append in sequence', () => {
 const doc = { 'x-targets': [{ before: 1 }, []] } as unknown as OpenAPIV3.Document;
 applyOverlays(doc, overlays([{ target: "$['x-targets'][*]", update: { value: 2 } }, { target: "$['x-targets'][1]", update: 'last' }]));
 assert.deepEqual((doc as any)['x-targets'], [{ before: 1, value: 2 }, [{ value: 2 }, 'last']]);
});
for (const targets of [[[], 'scalar'], [[], {}], [{}, []]]) {
 test(`all targets prevalidate before append for ${JSON.stringify(targets)}`, () => {
  const doc = { 'x-targets': structuredClone(targets) } as unknown as OpenAPIV3.Document;
  const before = structuredClone(doc);
  assert.throws(() => applyOverlays(doc, overlays([{ target: "$['x-targets'][*]", update: 3 }])));
  assert.deepEqual(doc, before);
 });
}
for (const update of [JSON.parse('{"__proto__":{"polluted":true}}'), { nested: [{ constructor: 1 }] }, { prototype: 1 }]) {
 test('forbidden update keys cannot append to arrays', () => {
  const doc = { 'x-targets': [[]] } as unknown as OpenAPIV3.Document;
  assert.throws(() => applyOverlays(doc, overlays([{ target: "$['x-targets'][*]", update }])), /forbidden key/);
  assert.deepEqual((doc as any)['x-targets'], [[]]);
 });
}
test('remove wins over update for array target', () => {
 const doc = { 'x-targets': { items: [1] } } as unknown as OpenAPIV3.Document;
 applyOverlays(doc, overlays([{ target: "$['x-targets'].items", remove: true, update: null }]));
 assert.deepEqual((doc as any)['x-targets'], {});
});

test('public generation loads an array append overlay and emits its parameter', async () => {
 const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const { execFile } = await import('node:child_process');
 const { promisify } = await import('node:util');
 const { fileURLToPath } = await import('node:url');
 const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlay-append-'));
 try {
  const spec = join(dir, 'spec.json'), overlay = join(dir, 'overlay.json'), out = join(dir, 'out');
  await writeFile(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'Append', version: '1' }, paths: { '/': { get: { operationId: 'get', parameters: [], responses: { '200': { description: 'ok' } } } } } }));
  await writeFile(overlay, JSON.stringify(overlays([{ target: '$.paths.*.get.parameters', update: { name: 'limit', in: 'query', schema: { type: 'integer' } } }])[0]!.overlay));
  await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'generate', spec, '--out', out, '--overlay', overlay], { timeout: 30000 });
  const manifest = JSON.parse(await readFile(join(out, 'operations.json'), 'utf8'));
  assert.ok(manifest.tools[0].args.some((arg: any) => arg.name === 'limit' && arg.location === 'query'));
 } finally { await rm(dir, { recursive: true, force: true }); }
});
