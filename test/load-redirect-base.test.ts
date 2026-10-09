import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadSpec } from '../src/load.js';

for (const version of ['3.0.3', '2.0']) {
  test(`OpenAPI ${version} resolves references against the final redirected root URL without bypassing private-host checks`, async () => {
    let refs = 0;
    const server = createServer((req, res) => {
      if (req.url === '/entry.json') {
        res.writeHead(302, { location: '/versioned/spec.json' }); res.end();
      } else if (req.url === '/versioned/spec.json') {
        res.setHeader('content-type', 'application/json');
        const schemas = { Value: { $ref: './defs.json' } };
        res.end(JSON.stringify({ info: { title: 'Redirect', version: '1' }, paths: {},
          ...(version === '2.0' ? { swagger: version, definitions: schemas } : { openapi: version, components: { schemas } }),
        }));
      } else { refs++; res.end('{"type":"string"}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      await assert.rejects(loadSpec(`http://127.0.0.1:${address.port}/entry.json`), (error: unknown) =>
        error instanceof Error && /versioned\/defs\.json/.test(error.message) && /resolve|Unsafe/.test(error.message));
      assert.equal(refs, 0, 'redirect handling must keep private relative refs blocked');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
