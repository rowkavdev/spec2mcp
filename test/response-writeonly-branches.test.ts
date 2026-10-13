import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
const THEN = ['th', 'en'].join('');
const oracle = new Ajv2020({ strict: false });
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };
async function output(schema: unknown) {
 const doc = { openapi: '3.1.0', info: { title: 'Response branches', version: '1' }, components: { schemas: {} }, paths: { '/': { get: {
  operationId: 'get', responses: { '200': { description: 'ok', content: { 'application/json': { schema } } } },
 } } } } as unknown as OpenAPIV3.Document;
 await init(doc); return buildManifest(doc).tools[0]!.outputSchema!;
}
for (const branch of ['then', 'else']) for (const nesting of ['root', 'allOf', 'property', 'items']) {
 test(`response ${branch} removes inherited writeOnly requirement at ${nesting}`, async () => {
  const node = { type: 'object', properties: { secret: { type: 'string', writeOnly: true }, token: { type: 'string' }, visible: { type: 'integer', minimum: 2 } },
    if: { required: ['token'] }, [branch]: { required: ['secret', 'visible'] } };
  const projected = { ...node, [branch]: { required: ['visible'] } };
  const wrapSchema = (value: unknown) => nesting === 'allOf' ? { type: 'object', allOf: [value] } : nesting === 'property' ? { type: 'object', properties: { child: value }, required: ['child'] } : nesting === 'items' ? { type: 'object', properties: { children: { type: 'array', items: value } }, required: ['children'] } : value;
  const wrapValue = (value: unknown) => nesting === 'property' ? { child: value } : nesting === 'items' ? { children: [value] } : value;
  const schema = await output(wrapSchema(node));
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(schema)));
  const expected = oracle.compile(wrapSchema(projected) as object);
  for (const value of [{ ...(branch === 'then' ? { token: 'x' } : {}), visible: 3 }, (branch === 'then' ? { token: 'x' } : {}), { ...(branch === 'then' ? { token: 'x' } : {}), visible: 1 }]) {
   assert.equal(validate(wrapValue(value)), expected(wrapValue(value)));
  }
 });
}
for (const key of ['if', 'not', 'anyOf', 'oneOf']) {
 test(`response ${key} does not inherit writeOnly names`, async () => {
  const branch = { required: ['secret'] };
  const node = { type: 'object', properties: { secret: { type: 'string', writeOnly: true }, token: { type: 'string' } }, [key]: key === 'anyOf' || key === 'oneOf' ? [branch] : branch };
  const schema = await output(node);
  assert.deepEqual(schema[key], node[key as keyof typeof node]);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(schema)));
  const expected = oracle.compile(node);
  for (const value of [{}, { token: 'x' }, { secret: 'x' }]) assert.equal(validate(value), expected(value));
 });
}
test('nested object property does not inherit parent writeOnly names', async () => {
 const schema = await output({ type: 'object', properties: { secret: { type: 'string', writeOnly: true }, child: { type: 'object', if: { required: ['token'] }, [THEN]: { required: ['secret'] }, properties: { secret: { type: 'string' }, token: { type: 'string' } } } } });
 assert.deepEqual((schema.properties as any).child.then.required, ['secret']);
});
test('allOf same-level writeOnly names reach then and else', async () => {
 const schema = await output({ type: 'object', allOf: [{ properties: { secret: { type: 'string', writeOnly: true } } }, { if: { required: ['token'] }, [THEN]: { required: ['secret'] }, else: { required: ['secret'] } }] });
 assert.equal(JSON.stringify(schema).includes('"required":["secret"]'), false);
});

for (const held of ['if', 'not', 'anyOf', 'oneOf']) for (const nesting of ['root', 'allOf', 'property', 'items']) for (const inside of ['root', 'allOf', 'property', 'items']) {
 test(`conditional projection stays disabled beneath ${held} at ${nesting} inside ${inside}`, async () => {
  const inner = { type: 'object', properties: { secret: { writeOnly: true } }, if: { required: ['token'] }, [THEN]: { required: ['secret'] }, else: { required: ['secret'] } };
  const nested = inside === 'allOf' ? { allOf: [inner] } : inside === 'property' ? { properties: { child: inner } } : inside === 'items' ? { properties: { children: { type: 'array', items: inner } } } : inner;
  const node = { type: 'object', [held]: held === 'anyOf' || held === 'oneOf' ? [nested] : nested,
    ...(held === 'if' ? { [THEN]: { required: ['visible'] }, else: { required: ['other'] } } : {}) };
  const wrapSchema = (value: unknown) => nesting === 'allOf' ? { type: 'object', allOf: [value] } : nesting === 'property' ? { type: 'object', properties: { child: value } } : nesting === 'items' ? { type: 'object', properties: { children: { type: 'array', items: value } } } : value;
  const wrapValue = (value: unknown) => nesting === 'property' ? { child: value } : nesting === 'items' ? { children: [value] } : value;
  const original = wrapSchema(node);
  const schema = await output(original);
  assert.deepEqual(schema, original);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(schema)));
  const expected = oracle.compile(original as object);
  for (const value of [{ token: 'x' }, { token: 'x', other: 1 }, { token: 'x', visible: 1 }, { token: 'x', secret: 's', visible: 1 }, {}]) assert.equal(validate(wrapValue(value)), expected(wrapValue(value)));
 });
}
