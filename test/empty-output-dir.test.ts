import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SPEC = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

for (const flag of ['--out', '-o']) {
  test(`generate rejects empty ${flag} instead of overwriting the working directory`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-empty-out-'));
    try {
      const sentinel = join(dir, 'package.json');
      await writeFile(sentinel, '{"private":true,"name":"existing-project"}');
      await assert.rejects(run(process.execPath, [TSX, CLI, 'generate', SPEC, flag, ''], { cwd: dir }),
        (error: unknown) => /--out must be a non-empty directory path/.test((error as { stderr: string }).stderr));
      assert.equal(await readFile(sentinel, 'utf8'), '{"private":true,"name":"existing-project"}');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
