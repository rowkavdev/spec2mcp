import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const worker = fileURLToPath(new URL('./fixtures/large-output-worker.ts', import.meta.url));

test('shared exponential response graphs stay within a 1GB heap across 612 operations', async () => {
  const { stdout } = await run(process.execPath,
    ['--max-old-space-size=1024', '--import', 'tsx', worker], { timeout: 60_000 });
  assert.match(stdout, /Generated 612 tools, 0 with outputSchema/);
});
