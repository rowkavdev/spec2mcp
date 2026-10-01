import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadSpec } from '../src/load.js';

test('a spec served from a loopback URL loads after the first fetch (#168)', async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Local', version: '1' },
      paths: {},
      components: { schemas: {} },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const doc = await loadSpec(`http://127.0.0.1:${address.port}/spec.json`);
    assert.equal(doc.info.title, 'Local');
    assert.equal(requests, 1, 'the root document is fetched once');
  } finally {
    server.close();
  }
});
