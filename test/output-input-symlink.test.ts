import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SPEC = fileURLToPath(new URL('./fixtures/petstore.yaml', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

for (const kind of ['spec', 'overlay', 'config']) {
  test(`generate protects a ${kind} input symlink inside output even when its target is outside`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-linked-input-'));
    try {
      const out = join(dir, 'out'); await mkdir(out);
      const external = join(dir, 'external.json');
      const source = kind === 'spec' ? await readFile(SPEC, 'utf8') : kind === 'config' ? '{}' :
        JSON.stringify({ overlay: '1.0.0', info: { title: 'noop', version: '1' }, actions: [] });
      await writeFile(external, source);
      const link = join(out, kind === 'config' ? 'spec2mcp.config.json' : 'operations.json');
      await symlink(external, link);
      const args = ['generate', kind === 'spec' ? link : SPEC, '--out', out];
      if (kind !== 'spec') args.push(kind === 'overlay' ? '--overlay' : '--config', link);
      await assert.rejects(run(process.execPath, [TSX, CLI, ...args]),
        (error: unknown) => /Output directory contains .* input/.test((error as { stderr: string }).stderr));
      assert.ok((await lstat(link)).isSymbolicLink(), 'input link must not be replaced by generated output');
      assert.equal(await readFile(link, 'utf8'), source);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
