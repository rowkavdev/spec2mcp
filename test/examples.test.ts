/**
 * Drift guard: every committed example project must be byte-identical to
 * what the current generator emits from the example's openapi.yaml and
 * spec2mcp.config.json. When generator output changes on purpose,
 * regenerate the examples (see examples/README.md) and commit the result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));

/** Entries committed next to the generated output that generation does not emit. */
const NON_GENERATED = new Set(['openapi.yaml', 'node_modules']);

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (NON_GENERATED.has(entry.name)) continue;
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), join(prefix, entry.name))));
    else files.push(join(prefix, entry.name));
  }
  return files.sort();
}

const examples = (await readdir(EXAMPLES, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort();

for (const name of examples) {
  test(`examples/${name} matches current generator output`, async () => {
    const committed = join(EXAMPLES, name);
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-example-'));
    try {
      const out = join(dir, 'out');
      await run(process.execPath, [
        TSX, CLI, 'generate',
        join(committed, 'openapi.yaml'),
        '--config', join(committed, 'spec2mcp.config.json'),
        '--out', out,
      ]);
      assert.deepEqual(await listFiles(out), await listFiles(committed), `examples/${name} has files the generator no longer emits (or is missing some)`);
      for (const file of await listFiles(committed)) {
        const [expected, actual] = await Promise.all([
          readFile(join(committed, file), 'utf8'),
          readFile(join(out, file), 'utf8'),
        ]);
        // Line endings are not meaningful drift: committed files may carry CRLF
        // on a Windows checkout (core.autocrlf) while the generator emits LF.
        const strip = (s: string) => s.replace(/\r\n/g, '\n');
        assert.equal(strip(actual), strip(expected), `examples/${name}/${file} has drifted - regenerate it (see examples/README.md)`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
