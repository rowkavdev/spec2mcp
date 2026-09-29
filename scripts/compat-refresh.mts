/**
 * Refresh the real-spec compat snapshots from their live sources, regenerate
 * test/fixtures/compat/expectations.json, and print the README "Verified
 * APIs" table rows. Requires network; not part of CI (the compat suite
 * itself runs offline against the snapshots this script writes).
 *
 *   npm run compat:refresh
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

const DIR = fileURLToPath(new URL('../test/fixtures/compat/', import.meta.url));

type SpecSource = {
  id: string;
  file: string;
  url: string;
  format: 'json' | 'yaml';
  /** Extra files the spec references externally, fetched alongside it. */
  extra?: { file: string; url: string }[];
};

const SPECS: SpecSource[] = [
  {
    id: 'stripe',
    file: 'stripe.json',
    url: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
    format: 'json',
  },
  {
    id: 'kubernetes',
    // The aggregated api/openapi-spec/swagger.json is Swagger 2.0; the v3
    // line publishes one OpenAPI 3 document per API group. core/v1 is the
    // representative snapshot.
    file: 'kubernetes.json',
    url: 'https://raw.githubusercontent.com/kubernetes/kubernetes/master/api/openapi-spec/v3/api__v1_openapi.json',
    format: 'json',
  },
  {
    id: 'spotify',
    // Spotify's spec references '../policies.yaml' externally; keep the
    // snapshot in a subdirectory so the relative ref keeps resolving.
    file: 'spotify/open-api-schema.yaml',
    url: 'https://developer.spotify.com/reference/web-api/open-api-schema.yaml',
    format: 'yaml',
    extra: [{ file: 'policies.yaml', url: 'https://developer.spotify.com/reference/policies.yaml' }],
  },
  {
    id: 'vercel',
    file: 'vercel.json',
    url: 'https://openapi.vercel.sh/',
    format: 'json',
  },
  {
    id: 'discord',
    file: 'discord.json',
    url: 'https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json',
    format: 'json',
  },
  {
    id: 'slack',
    // Slack publishes Swagger 2.0 only; the snapshot pins the 2.0
    // conversion path end to end (expectations record the converted 3.x).
    file: 'slack.json',
    url: 'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json',
    format: 'json',
  },
];

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

const refreshed = new Date().toISOString().slice(0, 10);
const expectations: { id: string; title: string; file: string; url: string; openapi: string; tools: number }[] = [];

for (const spec of SPECS) {
  const text = await fetchText(spec.url);
  // JSON snapshots are stored minified: identical document, ~50% smaller.
  const snapshot = spec.format === 'json' ? JSON.stringify(JSON.parse(text)) : text;
  const target = `${DIR}${spec.file}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, snapshot);
  for (const extra of spec.extra ?? []) {
    await writeFile(`${DIR}${extra.file}`, await fetchText(extra.url));
  }

  const doc = await loadSpec(target);
  await init(doc);
  const m = buildManifest(doc);
  expectations.push({ id: spec.id, title: m.apiTitle, file: spec.file, url: spec.url, openapi: m.specVersion, tools: m.tools.length });
  console.log(`${spec.id}: ${m.tools.length} tools (${m.apiTitle}, OpenAPI ${m.specVersion})`);
}

await writeFile(`${DIR}expectations.json`, JSON.stringify({ refreshed, specs: expectations }, null, 2) + '\n');

console.log('\nREADME table rows:\n');
console.log('| API | OpenAPI | Tools |');
console.log('| --- | --- | --- |');
for (const e of expectations) {
  console.log(`| [${e.title}](${e.url}) | ${e.openapi} | ${e.tools} |`);
}
console.log(`\nexpectations.json refreshed (${refreshed}). Review the snapshot diffs before committing.`);
