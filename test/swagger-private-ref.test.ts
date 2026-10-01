import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadSpec } from '../src/load.js';

test('Swagger URL roots keep private relative references blocked', async () => {
  let roots = 0;
  let references = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/spec.json') {
      roots++;
      res.end(JSON.stringify({ swagger: '2.0', info: { title: 'Local', version: '1' },
        paths: {}, definitions: { Value: { $ref: './defs.json' } } }));
    } else {
      references++;
      res.end(JSON.stringify({ type: 'string' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await assert.rejects(loadSpec(`http://127.0.0.1:${address.port}/spec.json`), /resolve|Unsafe/);
    assert.equal(roots, 1);
    assert.equal(references, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
