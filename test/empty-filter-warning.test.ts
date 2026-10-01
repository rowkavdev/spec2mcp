import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

test('generate warns when the filters leave no operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-empty-'));
  try {
    const { stdout, stderr } = await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--out', join(dir, 'o'), '--include', 'noSuchOperation']);
    assert.match(stdout, /Generated 0 tools/);
    assert.match(stderr, /warning: .*--include\/--exclude.*no operations/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generate stays quiet when filters keep some operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-nonempty-'));
  try {
    const { stderr } = await run(process.execPath, [TSX, CLI, 'generate', PETSTORE, '--out', join(dir, 'o'), '--include', 'list*']);
    assert.doesNotMatch(stderr, /no operations/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
