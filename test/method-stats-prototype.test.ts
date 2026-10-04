import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';

test('method statistics count prototype-named methods as ordinary names', async () => {
  const forge = await init({ openapi: '3.0.3', info: { title: 'Stats', version: '1' }, components: { schemas: {} }, paths: {} } as never);
  forge.commands.set('test', { name: 'test', methods: ['constructor', 'toString', '__proto__', '__proto__'].map(name => ({ name })) } as never);
  const stats = forge.methodStats();
  assert.equal(stats.total, 4);
  assert.equal(stats.byMethod.constructor, 1);
  assert.equal(stats.byMethod.toString, 1);
  assert.equal(stats.byMethod['__proto__'], 2);
  assert.equal(Object.keys(stats.byMethod).length, 3);
});
