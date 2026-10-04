import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';

test('a failed transformer does not leak emitted files into the next transform', async () => {
  const forge = await init({ openapi: '3.0.3', info: { title: 'Buffer', version: '1' }, components: { schemas: {} }, paths: {} } as never);
  await assert.rejects(forge.transform(async instance => {
    instance.emit('failed.txt', 'partial');
    throw new Error('failed transformation');
  }), /failed transformation/);
  const files = await forge.transform(async instance => { instance.emit('success.txt', 'complete'); });
  assert.deepEqual(files.map(file => file.path), ['success.txt']);
});
