import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, access, mkdir, symlink } from 'node:fs/promises';
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

test('#188 output cleaning rejects local spec, overlay and config inputs within output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlap-'));
  try {
    const spec = join(dir, 'spec.json');
    const overlay = join(dir, 'overlay.yaml');
    const config = join(dir, 'config.json');
    await (await import('node:fs/promises')).writeFile(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'Demo', version: '1' },
      paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'OK' } } } } } }));
    await (await import('node:fs/promises')).writeFile(overlay, 'overlay: 1.0.0\ninfo: {title: noop, version: 1}\nactions: []\n');
    await (await import('node:fs/promises')).writeFile(config, '{}');
    await mkdir(join(dir, 'nested'));
    const nestedSpec = join(dir, 'nested', 'nested-spec.json');
    await (await import('node:fs/promises')).copyFile(spec, nestedSpec);
    const cases = [
      [spec, ['generate', spec, '--out', dir]],
      [nestedSpec, ['generate', nestedSpec, '--out', join(dir, 'nested')]],
      [overlay, ['generate', PETSTORE, '--overlay', overlay, '--out', dir]],
      [config, ['generate', PETSTORE, '--config', config, '--out', dir]],
    ] as const;
    for (const [protectedFile, args] of cases) {
      await assert.rejects(run(process.execPath, [TSX, CLI, ...args]),
        (error: unknown) => /output.*(spec|overlay|config).*input/i.test((error as { stderr: string }).stderr));
      await access(protectedFile);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('#188 watch startup rejects overlapping output before opening a watcher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-watch-overlap-'));
  try {
    const spec = join(dir, 'spec.json');
    await (await import('node:fs/promises')).writeFile(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'Demo', version: '1' },
      paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'OK' } } } } } }));
    await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', spec, '--out', dir, '--watch'], { timeout: 3000 }),
      (error: unknown) => /output directory contains spec input/i.test((error as { stderr: string }).stderr));
    await access(spec);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#188 symlinked output parent cannot hide a protected spec', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-link-overlap-'));
  try {
    const real = join(dir, 'real');
    await mkdir(real);
    const spec = join(real, 'spec.json');
    await (await import('node:fs/promises')).writeFile(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'Demo', version: '1' },
      paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'OK' } } } } } }));
    await symlink(real, join(dir, 'linked'));
    await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', spec, '--out', join(dir, 'linked')]),
      (error: unknown) => /output directory contains spec input/i.test((error as { stderr: string }).stderr));
    await access(spec);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#166 generated config persists a custom env prefix across regeneration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-envprefix-'));
  try {
    const out = join(dir, 'demo-mcp');
    await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--out', out, '--name', 'demo', '--env-prefix', 'SECRET']);
    const first = JSON.parse(await readFile(join(out, 'operations.json'), 'utf8'));
    assert.equal(first.auth.schemes[0].envVar, 'SECRET_BEARER_AUTH');
    const saved = JSON.parse(await readFile(join(out, 'spec2mcp.config.json'), 'utf8'));
    assert.equal(saved.envPrefix, 'SECRET', 'the emitted config carries the effective prefix');
    // Regenerate from the emitted config (copied outside the output directory,
    // which the output-safety guard requires): the credential variable must not change.
    const configCopy = join(dir, 'settings.json');
    await (await import('node:fs/promises')).copyFile(join(out, 'spec2mcp.config.json'), configCopy);
    await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--config', configCopy, '--out', out]);
    const second = JSON.parse(await readFile(join(out, 'operations.json'), 'utf8'));
    assert.equal(second.auth.schemes[0].envVar, 'SECRET_BEARER_AUTH', 'regeneration keeps the same credential variable');
    const resaved = JSON.parse(await readFile(join(out, 'spec2mcp.config.json'), 'utf8'));
    assert.equal(resaved.envPrefix, 'SECRET', 'the round trip keeps the prefix in the emitted config');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
