import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadSpec } from '../src/load.js';

for (const version of ['3.0.3', '2.0']) {
  test(`#168 local ${version} root uses the already-fetched document`, async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ...(version === '2.0' ? { swagger: version } : { openapi: version }),
        info: { title: 'Local', version: '1' }, paths: {},
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const doc = await loadSpec(`http://127.0.0.1:${address.port}/spec.json`);
      assert.equal(doc.info.title, 'Local');
      assert.equal(requests, 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}

test('#168 loading a local root does not disable private external-ref protection', async () => {
  let referenceHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/defs.json') referenceHits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/spec.json' ? {
      openapi: '3.0.3', info: { title: 'Local', version: '1' }, paths: {},
      components: { schemas: { Value: { $ref: './defs.json' } } },
    } : { type: 'string' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await assert.rejects(loadSpec(`http://127.0.0.1:${address.port}/spec.json`), /resolve|Unsafe/);
    assert.equal(referenceHits, 0, 'private ref target must not receive a request');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
