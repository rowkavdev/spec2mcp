import { build } from 'esbuild';
import { chmod, copyFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile: 'dist/cli.mjs',
  banner: { js: '#!/usr/bin/env node' },
  // Vendored forge TS is bundled in; npm packages stay external.
});
await chmod('dist/cli.mjs', 0o755);
await copyFile('vendor/forge/LICENSE', 'dist/LICENSE-forge');
await writeFile('dist/NOTICE-forge', 'Bundled Forge source is Apache-2.0, copyright Cloudflare, Inc. The complete license is in LICENSE-forge.\n');
console.log('built dist/cli.mjs');
