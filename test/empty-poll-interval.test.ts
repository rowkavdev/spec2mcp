import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SPEC = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

for (const command of ['generate', 'serve']) {
  test(`${command} rejects an empty poll interval without watch before writing or listening`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-empty-poll-'));
    try {
      const out = join(dir, 'out');
      const args = command === 'serve' ? ['--transport', 'http', '--port', '0'] : ['--out', out];
      await assert.rejects(run(process.execPath, [TSX, CLI, command, SPEC, ...args, '--poll-interval', ''], { timeout: 3000 }),
        (error: unknown) => {
          const result = error as { code: unknown; killed: boolean; stderr: string };
          return result.code === 1 && !result.killed && /--poll-interval requires --watch and an HTTP\(S\) spec URL/.test(result.stderr) && !/listening/.test(result.stderr);
        });
      await assert.rejects(access(out));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
