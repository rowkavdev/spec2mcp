import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

for (const config of ['spec2mcp.config.json', './spec2mcp.config.json', 'missing.json']) {
  test(`explicit missing config ${config} fails before generating`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-explicit-config-'));
    try {
      const out = join(dir, 'out');
      await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--config', config, '--out', out], { cwd: dir }),
        (error: unknown) => /ENOENT/.test((error as { stderr: string }).stderr));
      await assert.rejects(access(out));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('implicit missing default config still permits generation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-implicit-config-'));
  try {
    const out = join(dir, 'out');
    const { stdout } = await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--out', out], { cwd: dir });
    assert.match(stdout, /Generated 7 tools/);
    await access(join(out, 'operations.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
