import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';

for (const name of ['const', 'default', 'example']) {
  test(`type normalization visits dependency schema named ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dependency-type-array-'));
    try {
      const path = join(dir, 'spec.json');
      const literal = { type: ['string', 'null'] };
      await writeFile(path, JSON.stringify({ openapi: '3.0.3', info: { title: 'Dependency types', version: '1' }, paths: {}, components: { schemas: {
        Payload: { type: 'object', dependencies: { [name]: { type: ['string', 'null'], const: literal }, plain: ['other'] } },
      } } }));
      const doc = await loadSpec(path);
      const result = (doc.components!.schemas!.Payload as any).dependencies;
      assert.equal(result[name].type, 'string');
      assert.equal(result[name].nullable, true);
      assert.deepEqual(result[name].const, literal);
      assert.deepEqual(result.plain, ['other']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
