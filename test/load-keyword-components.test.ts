import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';

for (const name of ['const', 'default', 'example', 'enum', 'examples']) {
  test(`type normalization visits schema component named ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'component-type-array-'));
    try {
      const path = join(dir, 'spec.json');
      const literal = { type: ['integer', 'string'] };
      await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Component types', version: '1' }, paths: {},
        components: { schemas: { [name]: { type: ['string', 'null'], const: literal } } } }));
      const doc = await loadSpec(path);
      const schema = doc.components!.schemas![name] as any;
      assert.equal(schema.type, 'string');
      assert.equal(schema.nullable, true);
      assert.deepEqual(schema.const, literal);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
