import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchSpec, type WatchHandle } from '../src/watch.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), 'editing the symlink target must trigger regeneration');
}

for (const kind of ['root', 'overlay', 'dependency']) {
  test(`watch regenerates when a symlinked ${kind} target changes in another directory`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-symlink-watch-'));
    let handle: WatchHandle | undefined;
    let count = 0;
    try {
      const inputs = join(dir, 'inputs'), targets = join(dir, 'targets');
      await mkdir(inputs); await mkdir(targets);
      const root = join(inputs, 'root.json'), link = join(inputs, 'linked.json');
      const target = join(targets, 'target.json');
      await writeFile(root, 'root'); await writeFile(target, 'first');
      await symlink(target, kind === 'root' ? root + '.link' : link);
      handle = await watchSpec(kind === 'root' ? root + '.link' : root, async () => { count++; }, {
        ...(kind === 'overlay' ? { additionalInputs: [link] } : {}),
        ...(kind === 'dependency' ? { discoverInputs: async () => [link] } : {}),
        log() {},
      });
      assert.equal(count, 1);
      const replacement = join(targets, 'replacement.json');
      await writeFile(replacement, 'second');
      await rename(replacement, target);
      await waitFor(() => count === 2);
      await writeFile(target, 'second');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(count, 2, 'unchanged content must not regenerate');
      const nextTarget = join(targets, 'next.json');
      await writeFile(nextTarget, 'third');
      const nextLink = join(inputs, 'next-link');
      await symlink(nextTarget, nextLink);
      await rename(nextLink, kind === 'root' ? root + '.link' : link);
      await waitFor(() => count === 3);
      await writeFile(nextTarget, 'fourth');
      await waitFor(() => count === 4);
      handle.close();
      await writeFile(nextTarget, 'fifth');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(count, 4, 'close must stop watching the target');
    } finally { handle?.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
