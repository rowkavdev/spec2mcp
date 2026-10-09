import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';

for (const name of ['default', 'example', 'const']) {
  test(`type normalization visits request body component named ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'request-component-types-'));
    try {
      const path = join(dir, 'spec.json');
      const literal = { type: ['integer', 'string'] };
      await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Request types', version: '1' }, paths: {},
        components: { requestBodies: { [name]: { content: { 'application/json': { schema: { type: ['string', 'null'], default: literal } } } } } } }));
      const doc = await loadSpec(path);
      const schema = (doc.components!.requestBodies![name] as any).content['application/json'].schema;
      assert.equal(schema.type, 'string');
      assert.equal(schema.nullable, true);
      assert.deepEqual(schema.default, literal);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
