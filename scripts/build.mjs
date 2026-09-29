import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

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
console.log('built dist/cli.mjs');
