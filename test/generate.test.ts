import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, access, mkdir, symlink, stat, writeFile } from 'node:fs/promises';
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

test('#298 --poll-interval above the timer limit is rejected instead of polling continuously', async () => {
  for (const seconds of ['3000000', '2147484', '0.0001', '0.5']) {
    await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', 'https://example.invalid/spec.json', '--watch', '--poll-interval', seconds], { timeout: 5000 }),
      (error: unknown) => /--poll-interval must be/i.test((error as { stderr: string }).stderr), seconds);
  }
});

test('#302 --help states the --poll-interval range', async () => {
  const { stdout } = await run(process.execPath, [TSX, CLI, '--help']);
  assert.match(stdout, /--poll-interval <seconds>\s+URL polling period with --watch, 1 to 2147483/);
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

test('#164 regeneration preserves installed dependencies and user files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-preserve-'));
  try {
    const out = join(dir, 'demo-mcp');
    await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--out', out]);
    const sdkFile = join(out, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
    await mkdir(join(sdkFile, '..'), { recursive: true });
    await writeFile(sdkFile, '{"name":"installed"}');
    await writeFile(join(out, 'notes.txt'), 'hand kept');
    const { stdout } = await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--out', out]);
    assert.equal(await readFile(sdkFile, 'utf8'), '{"name":"installed"}', 'installed dependencies survive regeneration');
    assert.equal(await readFile(join(out, 'notes.txt'), 'utf8'), 'hand kept', 'files the generator does not own survive regeneration');
    assert.match(stdout, /Next: cd .* && npm start/, 'an installed output skips the install step');
    assert.doesNotMatch(stdout, /npm install && npm start/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#164 watch regeneration preserves installed dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-watch-preserve-'));
  let child;
  try {
    const spec = join(dir, 'spec.yaml');
    const original = await readFile(PETSTORE, 'utf8');
    await writeFile(spec, original);
    const out = join(dir, 'demo-mcp');
    child = spawn(process.execPath, [TSX, CLI, 'generate', spec, '--out', out, '--watch'], { stdio: 'ignore' });
    const manifestPath = join(out, 'operations.json');
    for (let i = 0; i < 200; i++) {
      try { await access(manifestPath); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    const initial = (await stat(manifestPath)).mtimeMs;
    const sdkFile = join(out, 'node_modules', 'sdk-marker');
    await mkdir(join(out, 'node_modules'), { recursive: true });
    await writeFile(sdkFile, 'installed');
    await writeFile(spec, `${original}\n# touched\n`);
    for (let i = 0; i < 200; i++) {
      if ((await stat(manifestPath)).mtimeMs !== initial) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.notEqual((await stat(manifestPath)).mtimeMs, initial, 'watch regenerated the project');
    assert.equal(await readFile(sdkFile, 'utf8'), 'installed', 'installed dependencies survive a watch regeneration');
  } finally {
    child?.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('generation refuses to overwrite an external reference file inside output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-ref-overlap-'));
  try {
    const out = join(dir, 'out');
    await mkdir(out);
    const dependency = join(out, 'operations.json');
    const original = JSON.stringify({ type: 'object', properties: { id: { type: 'integer' } } });
    await writeFile(dependency, original);
    const spec = join(dir, 'spec.json');
    await writeFile(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'Refs', version: '1' },
      paths: { '/': { get: { operationId: 'get', responses: { '200': { description: 'ok', content: {
        'application/json': { schema: { $ref: './out/operations.json' } },
      } } } } } } }));
    await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', spec, '--out', out]),
      (error: unknown) => /output directory contains.*reference.*input/i.test((error as { stderr: string }).stderr));
    assert.equal(await readFile(dependency, 'utf8'), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('generation protects local dependencies referenced only by an overlay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlay-ref-overlap-'));
  try {
    const out = join(dir, 'out');
    await mkdir(out);
    const dependency = join(out, 'operations.json');
    const original = JSON.stringify({ type: 'string' });
    await writeFile(dependency, original);
    const spec = join(dir, 'spec.json');
    await writeFile(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'Overlay refs', version: '1' }, paths: {} }));
    const overlay = join(dir, 'overlay.json');
    await writeFile(overlay, JSON.stringify({ overlay: '1.0.0', info: { title: 'Ref', version: '1' }, actions: [
      { target: '$.info', update: { 'x-schema': { $ref: './out/operations.json' } } },
    ] }));
    await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', spec, '--overlay', overlay, '--out', out]),
      (error: unknown) => /output directory contains.*reference.*input/i.test((error as { stderr: string }).stderr));
    assert.equal(await readFile(dependency, 'utf8'), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const ref of ['./missing.json', 'http://example.invalid/x.json', 'http://127.0.0.1:1/x.json', '#/info']) {
  test(`overlay data reference ${ref} is not resolved by generation`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlay-data-'));
    try {
      const spec = join(dir, 'spec.json');
      await writeFile(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'Overlay data', version: '1' }, paths: {} }));
      const overlay = join(dir, 'overlay.json');
      await writeFile(overlay, JSON.stringify({ overlay: '1.0.0', info: { title: 'Ref', version: '1' }, actions: [
        { target: '$.info', update: { 'x-data': { $ref: ref } } },
      ] }));
      const result = await run(process.execPath, [TSX, CLI, 'generate', spec, '--overlay', overlay, '--out', join(dir, 'out')]);
      assert.match(result.stdout, /Generated 0 tools/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('overlay reference protection uses the spec folder when the overlay lives elsewhere', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-overlay-base-'));
  try {
    await mkdir(join(dir, 'overlays'));
    await mkdir(join(dir, 'out'));
    const spec = join(dir, 'spec.json');
    await writeFile(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'Overlay base', version: '1' }, paths: {} }));
    const dependency = join(dir, 'out', 'operations.json');
    await writeFile(dependency, '{}');
    const overlay = join(dir, 'overlays', 'overlay.json');
    await writeFile(overlay, JSON.stringify({ overlay: '1.0.0', info: { title: 'Ref', version: '1' }, actions: [
      { target: '$.info', update: { 'x-data': { $ref: './out/operations.json' } } },
    ] }));
    await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', spec, '--overlay', overlay, '--out', join(dir, 'out')]),
      (error: unknown) => /output directory contains.*reference.*input/i.test((error as { stderr: string }).stderr));
    assert.equal(await readFile(dependency, 'utf8'), '{}');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('generation protects the implicitly loaded default config from overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-default-config-'));
  try {
    const config = join(dir, 'spec2mcp.config.json');
    const original = JSON.stringify({ name: 'keep-my-settings', include: ['list*'] });
    await writeFile(config, original);
    await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--out', dir], { cwd: dir }),
      (error: unknown) => /output directory contains config input/i.test((error as { stderr: string }).stderr));
    assert.equal(await readFile(config, 'utf8'), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
