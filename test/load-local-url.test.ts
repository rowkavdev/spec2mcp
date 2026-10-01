import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadSpec } from '../src/load.js';

test('#168 a spec served on a loopback URL loads', async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      openapi: '3.0.3', info: { title: 'Local', version: '1' },
      paths: {}, components: { schemas: {} },
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
    server.close();
  }
});

test('#168 relative refs on the same loopback origin resolve', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/schemas/pet.json') return void res.end(JSON.stringify({ type: 'object', properties: { id: { type: 'string' } } }));
    res.end(JSON.stringify({
      openapi: '3.0.3', info: { title: 'Local', version: '1' }, paths: {},
      components: { schemas: { Pet: { $ref: 'schemas/pet.json' } } },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const doc = await loadSpec(`http://127.0.0.1:${address.port}/spec.json`);
    const pet = (doc.components!.schemas as any).Pet;
    assert.equal(pet.properties.id.type, 'string');
  } finally {
    server.close();
  }
});

test('#168 a loopback spec cannot pull refs from another host', async () => {
  const other = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"type":"string"}'); });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherPort = (other.address() as { port: number }).port;
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      openapi: '3.0.3', info: { title: 'Local', version: '1' }, paths: {},
      components: { schemas: { Pet: { $ref: `http://localhost:${otherPort}/x.json` } } },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    await assert.rejects(loadSpec(`http://127.0.0.1:${address.port}/spec.json`));
  } finally {
    server.close();
    other.close();
  }
});
