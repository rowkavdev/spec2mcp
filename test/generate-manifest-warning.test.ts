import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

test('generate prints manifest warnings instead of hiding them in operations.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-manifest-warning-'));
  try {
    const spec = join(dir, 'spec.json');
    const out = join(dir, 'out');
    await writeFile(spec, JSON.stringify({
      openapi: '3.0.3', info: { title: 'Warning', version: '1' },
      paths: { '/items/{id}': { get: { operationId: 'getItem', responses: { '200': { description: 'OK' } } } } },
    }));
    const { stdout, stderr } = await run(process.execPath, [TSX, CLI, 'generate', spec, '--out', out]);
    assert.match(stdout, /Generated 1 tools/);
    const manifest = JSON.parse(await readFile(join(out, 'operations.json'), 'utf8'));
    assert.equal(manifest.warnings.length, 1);
    assert.ok(stderr.includes(`warning: ${manifest.warnings[0]}`), 'the generated warning is also visible on stderr');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
