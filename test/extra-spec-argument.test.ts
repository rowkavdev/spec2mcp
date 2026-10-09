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

for (const command of ['generate', 'shorthand', 'serve']) {
  test(`${command} rejects a second spec argument before generating or listening`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-extra-spec-'));
    try {
      const sentinel = join(dir, 'operations.json');
      await writeFile(sentinel, 'existing project');
      const args = command === 'shorthand' ? [SPEC] : [command, SPEC];
      args.push('unintended-second-spec.yaml');
      args.push(...(command === 'serve' ? ['--transport', 'http', '--port', '0'] : ['--out', dir]));
      await assert.rejects(run(process.execPath, [TSX, CLI, ...args], { cwd: dir, timeout: 3000 }),
        (error: unknown) => {
          const result = error as { code: unknown; killed: boolean; stderr: string };
          return result.code === 1 && !result.killed &&
            /expected exactly one <spec> argument/i.test(result.stderr) &&
            !/listening/i.test(result.stderr);
        });
      assert.equal(await readFile(sentinel, 'utf8'), 'existing project');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
