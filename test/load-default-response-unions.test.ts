import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/load.js';

for (const name of ['default', '200']) {
  test(`type normalization visits response ${name} schemas without changing payload defaults`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'response-type-array-'));
    try {
      const path = join(dir, 'spec.json');
      const literal = { type: ['integer', 'string'] };
      await writeFile(path, JSON.stringify({ openapi: '3.1.0', info: { title: 'Response types', version: '1' }, paths: {
        '/': { get: { operationId: 'get', responses: { [name]: { description: 'ok', content: { 'application/json': {
          schema: { type: ['string', 'null'], default: literal },
        } } } } } },
      } }));
      const doc = await loadSpec(path);
      const schema = (doc.paths['/']!.get!.responses[name] as any).content['application/json'].schema;
      assert.equal(schema.type, 'string');
      assert.equal(schema.nullable, true);
      assert.deepEqual(schema.default, literal);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
