#!/usr/bin/env node
/** Run this script in a checkout of each revision to compare peak RSS.
 * Usage: node scripts/bench-output-schema.mjs [operation-count] [heap-MB]
 * For a checkout predating this fixture, copy the script and fixture files
 * into that checkout without changing its src/manifest.ts.
 * The worker reports elapsed time and its process resourceUsage().maxRSS.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('../test/fixtures/large-output-worker.ts', import.meta.url));
const count = process.argv[2] ?? '612';
const heap = process.argv[3] ?? '1024';
const result = spawnSync(process.execPath,
  [`--max-old-space-size=${heap}`, '--import', 'tsx', worker, count],
  { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
