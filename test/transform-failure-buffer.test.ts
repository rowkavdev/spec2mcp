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

test('an overlapping transform rejects without draining the active transform', async () => {
  const forge = await init({ openapi: '3.0.3', info: { title: 'Buffer', version: '1' }, components: { schemas: {} }, paths: {} } as never);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = forge.transform(async instance => {
    instance.emit('first.txt', 'first');
    await gate;
    instance.emit('last.txt', 'last');
  });

  try {
    await assert.rejects(forge.transform(async () => {
      assert.fail('overlapping transformer ran');
    }), /already running/);
  } finally {
    release();
  }

  assert.deepEqual((await active).map(file => file.path), ['first.txt', 'last.txt']);
  const next = await forge.transform(async instance => { instance.emit('next.txt', 'next'); });
  assert.deepEqual(next.map(file => file.path), ['next.txt']);
});
