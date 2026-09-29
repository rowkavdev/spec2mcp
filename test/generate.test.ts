import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

test('generate emits a complete project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-gen-'));
  try {
    const out = join(dir, 'petstore-mcp');
    const { stdout } = await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--out', out]);
    assert.match(stdout, /Generated 7 tools/);

    for (const f of ['operations.json', 'server.mjs', 'package.json', 'README.md', '.env.example', '.gitignore']) {
      await access(join(out, f));
    }
    const manifest = JSON.parse(await readFile(join(out, 'operations.json'), 'utf8'));
    assert.equal(manifest.tools.length, 7);
    const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'pet-store-mcp');
    assert.ok(pkg.dependencies['@modelcontextprotocol/sdk']);
    const readme = await readFile(join(out, 'README.md'), 'utf8');
    assert.match(readme, /list_pets/);
    assert.match(readme, /PET_STORE_BEARER_AUTH/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
