import assert from 'node:assert/strict';
import { init } from '../../vendor/forge/index.js';
import { buildManifest } from '../../src/manifest.js';
import { largeOutputSpec } from './large-output-spec.js';

const count = Number(process.argv[2] ?? 612);
const start = performance.now();
const doc = largeOutputSpec(count);
await init(doc);
const manifest = buildManifest(doc);
assert.equal(manifest.tools.length, count);
const withSchema = manifest.tools.filter((tool) => tool.outputSchema).length;
if (!process.env.BENCH_BASELINE) assert.equal(withSchema, 0);
console.log(`Generated ${manifest.tools.length} tools, ${withSchema} with outputSchema`);
console.log(`Elapsed: ${((performance.now() - start) / 1000).toFixed(2)} s; Peak RSS: ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
