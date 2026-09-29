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

test('project config persists resolved settings and CLI flags override them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-config-'));
  try {
    const configPath = join(dir, 'settings.json');
    const out = join(dir, 'custom-mcp');
    await (await import('node:fs/promises')).writeFile(configPath, JSON.stringify({
      name: 'configured', baseUrl: 'https://configured.test/v2', include: ['operation:list*'], exclude: ['operation:listPets_2'],
    }));
    const { stdout } = await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--config', configPath,
      '--out', out, '--name', 'overridden', '--exclude', 'operation:listPets']);
    assert.match(stdout, /Generated 1 tools/);
    const manifest = JSON.parse(await readFile(join(out, 'operations.json'), 'utf8'));
    assert.equal(manifest.serverName, 'overridden');
    assert.equal(manifest.baseUrl, 'https://configured.test/v2');
    assert.deepEqual(manifest.tools.map((tool: { operationId: string }) => tool.operationId), ['listPets_2']);
    const saved = JSON.parse(await readFile(join(out, 'spec2mcp.config.json'), 'utf8'));
    assert.deepEqual(saved, {
      name: 'overridden', baseUrl: 'https://configured.test/v2', include: ['operation:list*'], exclude: ['operation:listPets'],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed explicit config fails rather than silently generating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-bad-config-'));
  try {
    const configPath = join(dir, 'bad.json');
    await (await import('node:fs/promises')).writeFile(configPath, '{"include":"list*"}');
    await assert.rejects(run(process.execPath, [TSX, CLI, PETSTORE, '--config', configPath, '--out', join(dir, 'out')]),
      (error: unknown) => /include must be an array of non-empty strings/.test((error as { stderr: string }).stderr));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
