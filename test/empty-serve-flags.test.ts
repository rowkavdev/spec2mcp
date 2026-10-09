import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SPEC = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

for (const args of [['--port', ''], ['--transport', '']]) {
  test(`generate rejects explicitly empty ${args[0]} before writing output`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-empty-flags-'));
    try {
      const out = join(dir, 'out');
      await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', SPEC, '--out', out, ...args]),
        (error: unknown) => /--transport/.test((error as { stderr: string }).stderr));
      await assert.rejects(access(out));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('serve rejects an empty HTTP port instead of listening on a random port', async () => {
  await assert.rejects(run(process.execPath, [TSX, CLI, 'serve', SPEC, '--transport', 'http', '--port', ''], { timeout: 3000 }),
    (error: unknown) => {
      const result = error as { stderr: string; code: unknown; killed: boolean };
      return result.code === 1 && !result.killed && /--port requires/.test(result.stderr);
    });
});
