import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SPEC = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

for (const args of [['--out', './expected-project'], ['-o', './expected-project'], ['--out', '']]) {
  test(`serve rejects generate-only output flag ${JSON.stringify(args)}`, async () => {
    await assert.rejects(run(process.execPath, [TSX, CLI, 'serve', SPEC, '--transport', 'http', '--port', '0', ...args], { timeout: 3000 }),
      (error: unknown) => {
        const result = error as { code: unknown; killed: boolean; stderr: string };
        return result.code === 1 && !result.killed && /--out is only valid with generate/.test(result.stderr) && !/listening/.test(result.stderr);
      });
  });
}
