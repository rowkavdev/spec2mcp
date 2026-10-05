/**
 * Regression tests for #213: once generation preserves the output directory
 * (#164), a symlink planted at an owned output path would redirect Forge's
 * write outside the directory - clobbering the symlink's target. Finalize
 * now writes through a temp file renamed over the destination and unlinks
 * symlinked ancestors inside the output directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../vendor/forge/index.js';

const DOC = { openapi: '3.0.3', info: { title: 'T', version: '1' }, components: { schemas: {} }, paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'OK' } } } } } };

test('#213 a symlink at an owned output path is replaced, not followed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-symlink-'));
  try {
    const external = join(dir, 'external.txt');
    await writeFile(external, 'KEEP ME');
    const out = join(dir, 'out');
    await mkdir(out, { recursive: true });
    await symlink(external, join(out, 'README.md'));
    const forge = await init(DOC as never);
    await forge.finalize(out, [{ path: 'README.md', content: 'generated readme' }]);
    assert.equal(await readFile(external, 'utf8'), 'KEEP ME', 'the external target is untouched');
    assert.ok(!(await lstat(join(out, 'README.md'))).isSymbolicLink(), 'the owned path is no longer a symlink');
    assert.equal(await readFile(join(out, 'README.md'), 'utf8'), 'generated readme');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#213 a symlinked directory inside the output cannot redirect writes outside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-dirsymlink-'));
  try {
    const externalDir = join(dir, 'external');
    await mkdir(externalDir, { recursive: true });
    const out = join(dir, 'out');
    await mkdir(out, { recursive: true });
    await symlink(externalDir, join(out, 'sub'));
    const forge = await init(DOC as never);
    await forge.finalize(out, [{ path: 'sub/file.txt', content: 'nested' }]);
    assert.ok(!(await lstat(join(out, 'sub'))).isSymbolicLink(), 'the symlinked directory was replaced with a real one');
    assert.equal(await readFile(join(out, 'sub', 'file.txt'), 'utf8'), 'nested');
    await assert.rejects(readFile(join(externalDir, 'file.txt'), 'utf8'), 'nothing escaped into the external directory');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#214 a pre-planted symlink at the predictable temp path cannot redirect the write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-tempsymlink-'));
  try {
    const external = join(dir, 'external.txt');
    await writeFile(external, 'KEEP ME');
    const out = join(dir, 'out');
    await mkdir(out, { recursive: true });
    // The temp name finalize used to construct: predictable from the pid.
    await symlink(external, join(out, `README.md.spec2mcp-${process.pid}-0.tmp`));
    const forge = await init(DOC as never);
    await forge.finalize(out, [{ path: 'README.md', content: 'generated readme' }]);
    assert.equal(await readFile(external, 'utf8'), 'KEEP ME', 'the external target is untouched');
    assert.equal(await readFile(join(out, 'README.md'), 'utf8'), 'generated readme');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finalize rejects sibling paths whose name shares the output prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-prefix-traversal-'));
  try {
    const doc = { openapi: '3.0.3', info: { title: 'Traversal', version: '1' }, components: { schemas: {} }, paths: {} } as any;
    const forge = await init(doc);
    const out = join(dir, 'out');
    await assert.rejects(forge.finalize(out, [{ path: '../outside/file.txt', content: 'escape' }]), /Path traversal detected/);
    await assert.rejects(readFile(join(dir, 'outside', 'file.txt')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('finalize validates output paths before cleaning existing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-clean-validation-'));
  try {
    const out = join(dir, 'out');
    await mkdir(out);
    const existing = join(out, 'keep.txt');
    await writeFile(existing, 'keep');
    const forge = await init(DOC as never);
    await assert.rejects(forge.finalize(out, [{ path: '../escape.txt', content: 'bad' }], { clean: true }), /Path traversal detected/);
    assert.equal(await readFile(existing, 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('finalize rejects file paths resolving to the output root before cleaning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-root-file-'));
  try {
    const forge = await init(DOC as never);
    for (const path of ['', '.', 'sub/..']) {
      const out = join(dir, 'out');
      await mkdir(out, { recursive: true });
      const existing = join(out, 'keep.txt');
      await writeFile(existing, 'keep');
      await assert.rejects(forge.finalize(out, [{ path, content: 'invalid file' }], { clean: true }), /file path.*output directory/i);
      assert.equal(await readFile(existing, 'utf8'), 'keep');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('finalize rejects conflicting file and directory paths before cleaning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-conflicting-files-'));
  try {
    const forge = await init(DOC as never);
    const out = join(dir, 'out');
    await mkdir(out);
    const existing = join(out, 'keep.txt');
    await writeFile(existing, 'keep');
    await assert.rejects(forge.finalize(out, [
      { path: 'sub', content: 'a file' },
      { path: 'sub/nested.txt', content: 'nested file' },
    ], { clean: true }), /conflicting output paths/i);
    assert.equal(await readFile(existing, 'utf8'), 'keep');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
