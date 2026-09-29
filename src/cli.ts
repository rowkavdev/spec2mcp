/**
 * spec2mcp - turn any OpenAPI spec into a working MCP server.
 *
 *   spec2mcp generate <spec> --out ./my-api-mcp   Emit a ready-to-run project
 *   spec2mcp serve <spec>                         Run an MCP server on stdio directly
 *
 * <spec> is a local file path or an http(s) URL, JSON or YAML.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from './load.js';
import { buildManifest } from './manifest.js';
import { createMcpTransformer } from './transformer.js';
import { watchSpec } from './watch.js';

const VERSION = '0.1.0';

const HELP = `spec2mcp ${VERSION} - turn any OpenAPI spec into a working MCP server

Usage:
  spec2mcp generate <spec> [options]   Generate a ready-to-run MCP server project
  spec2mcp serve <spec> [options]      Run an MCP server on stdio directly from the spec
  spec2mcp <spec> [options]            Shorthand for "generate"

Arguments:
  <spec>                               OpenAPI 3.x file path or URL (JSON or YAML)

Options:
  -o, --out <dir>                      Output directory (generate; default: ./<name>-mcp)
      --name <name>                    Server name (default: derived from the spec title)
      --base-url <url>                 Override the API base URL from the spec's servers list
      --watch                          Regenerate when the spec changes (generate only)
      --poll-interval <seconds>        URL polling period with --watch (default: 30)
  -h, --help                           Show this help
  -v, --version                        Show version

Examples:
  spec2mcp generate openapi.json --out ./petstore-mcp
  spec2mcp serve https://api.example.com/openapi.yaml
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exitCode = 1;
  process.exit(1);
}

async function runtimeSource(): Promise<string> {
  return readFile(new URL('../runtime/server.mjs', import.meta.url), 'utf8');
}

async function cmdGenerate(spec: string, flags: { out?: string; name?: string; baseUrl?: string }): Promise<void> {
  const doc = await loadSpec(spec);
  const forge = await init(doc);
  const probe = buildManifest(doc, { serverName: flags.name, baseUrl: flags.baseUrl });
  for (const warning of probe.auth.warnings) console.error(`warning: ${warning}`);
  const outDir = flags.out ?? `./${probe.serverName}-mcp`;
  const files = await forge.transform(createMcpTransformer(doc, { ...flags, runtimeSource: await runtimeSource() }));
  await forge.finalize(outDir, files, { clean: true });
  const toolCount = JSON.parse(files.find((f) => f.path === 'operations.json')?.content ?? '{}').tools?.length ?? 0;
  console.log(`Generated ${toolCount} tools in ${outDir}`);
  console.log(`Next: cd ${outDir} && npm install && npm start`);
  if (probe.auth.schemes.length > 0) {
    console.log(`Auth: set ${probe.auth.schemes.map((s) => s.envVar).join(', ')} (see .env.example)`);
  }
  if (!probe.baseUrl) {
    console.log(`Note: the spec declares no server URL - set ${probe.auth.baseUrlEnvVar} or regenerate with --base-url.`);
  }
}

async function cmdServe(spec: string, flags: { name?: string; baseUrl?: string }): Promise<void> {
  const doc = await loadSpec(spec);
  await init(doc);
  const manifest = buildManifest(doc, { serverName: flags.name, baseUrl: flags.baseUrl });
  for (const warning of manifest.auth.warnings) console.error(`warning: ${warning}`);
  const runtimeUrl = new URL('../runtime/server.mjs', import.meta.url).href;
  const { runServer } = (await import(runtimeUrl)) as { runServer: (manifest: import('./manifest.js').Manifest) => Promise<void> };
  await runServer(manifest);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (!first || first === '--help' || first === '-h') {
    console.log(HELP);
    return;
  }
  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return;
  }

  const known = new Set(['generate', 'serve']);
  const command = known.has(first ?? '') ? first : 'generate';
  const rest = known.has(first ?? '') ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      name: { type: 'string' },
      'base-url': { type: 'string' },
      watch: { type: 'boolean' },
      'poll-interval': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const spec = positionals[0];
  if (!spec) fail(`missing <spec> argument\n\n${HELP}`);
  const flags = { out: values.out, name: values.name, baseUrl: values['base-url'] };

  if (values['poll-interval'] && (!values.watch || !/^https?:\/\//i.test(spec))) {
    fail('--poll-interval requires --watch and an HTTP(S) spec URL');
  }
  if (values.watch && command === 'serve') fail('--watch is only supported by generate');
  if (values.watch) {
    const seconds = values['poll-interval'] === undefined ? 30 : Number(values['poll-interval']);
    if (!Number.isFinite(seconds) || seconds <= 0) fail('--poll-interval must be a positive number of seconds');
    const handle = await watchSpec(spec, () => cmdGenerate(spec, flags), { pollIntervalMs: seconds * 1000 });
    process.once('SIGINT', () => { handle.close(); process.exit(0); });
    process.once('SIGTERM', () => { handle.close(); process.exit(0); });
  } else if (command === 'serve') {
    await cmdServe(spec, flags);
  } else {
    await cmdGenerate(spec, flags);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
