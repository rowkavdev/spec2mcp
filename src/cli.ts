/**
 * spec2mcp - turn any OpenAPI spec into a working MCP server.
 *
 *   spec2mcp generate <spec> --out ./my-api-mcp   Emit a ready-to-run project
 *   spec2mcp serve <spec>                         Run an MCP server directly
 *
 * <spec> is a local file path or an http(s) URL, JSON or YAML.
 */
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { init } from '../vendor/forge/index.js';
import { applyOverlays } from './overlay.js';
import { ensureOperationIds, loadOverlays, loadSpec } from './load.js';
import type { OpenAPIV3 } from 'openapi-types';
import { buildManifest, DEFAULT_31_DIALECT } from './manifest.js';
import { createMcpTransformer } from './transformer.js';
import { watchSpec } from './watch.js';
import type { ManifestOptions } from './manifest.js';
import { readProjectConfig, resolveConfig, type ProjectConfig } from './config.js';
import { assertOutputDoesNotContainInputs } from './output-safety.js';

const VERSION = '0.1.0';

const HELP = `spec2mcp ${VERSION} - turn any OpenAPI spec into a working MCP server

Usage:
  spec2mcp generate <spec> [options]   Generate a ready-to-run MCP server project
  spec2mcp serve <spec> [options]      Run an MCP server directly from the spec
  spec2mcp <spec> [options]            Shorthand for "generate"

Arguments:
  <spec>                               OpenAPI 3.x file path or URL (JSON or YAML)

Options:
  -o, --out <dir>                      Output directory (generate; default: ./<name>-mcp)
      --name <name>                    Server name (default: derived from the spec title)
      --base-url <url>                 Override the API base URL from the spec's servers list
      --env-prefix <prefix>            Override the auth environment variable prefix
      --overlay <file>                 Apply an OpenAPI Overlay before generating (repeatable)
      --watch                          Regenerate when the spec changes (generate only)
      --poll-interval <seconds>        URL polling period with --watch (default: 30)
      --transport <stdio|http>         Transport (serve; default: stdio)
      --port <number>                  HTTP port (serve; default: 3000, localhost only)
      --include <selector>             Include operations (repeatable)
      --exclude <selector>             Exclude operations (repeatable; wins over include)
      --config <file>                   Read settings from a JSON config file
  -h, --help                           Show this help
  -v, --version                        Show version

Examples:
  spec2mcp generate openapi.json --out ./petstore-mcp
  spec2mcp serve https://api.example.com/openapi.yaml --transport http --port 3000
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exitCode = 1;
  process.exit(1);
}

async function runtimeSource(): Promise<string> {
  return readFile(new URL('../runtime/server.mjs', import.meta.url), 'utf8');
}

async function loadEffectiveSpec(spec: string, overlayPaths: string[]): Promise<OpenAPIV3.Document> {
  let doc = await loadSpec(spec);
  const overlays = await loadOverlays(overlayPaths);
  if (overlays.length > 0) {
    doc = applyOverlays(doc, overlays);
    // Overlay updates can reintroduce operation IDs that collide after
    // Forge's apostrophe normalization.
    ensureOperationIds(doc);
  }
  return doc;
}

async function cmdGenerate(spec: string, flags: ManifestOptions & { out?: string; name?: string }, config: ProjectConfig, configPath?: string): Promise<void> {
  if (flags.out) await assertOutputDoesNotContainInputs(flags.out, [{ label: 'spec', path: spec }, ...((config.overlays ?? []).map((path) => ({ label: 'overlay', path }))), { label: 'config', path: configPath }]);
  const doc = await loadEffectiveSpec(spec, config.overlays ?? []);
  const forge = await init(doc);
  const probe = buildManifest(doc, { serverName: flags.name, baseUrl: flags.baseUrl, envPrefix: flags.envPrefix, include: flags.include, exclude: flags.exclude });
  for (const warning of probe.auth.warnings) console.error(`warning: ${warning}`);
  const outDir = flags.out ?? `./${probe.serverName}-mcp`;
  await assertOutputDoesNotContainInputs(outDir, [{ label: 'spec', path: spec }, ...((config.overlays ?? []).map((path) => ({ label: 'overlay', path }))), { label: 'config', path: configPath }]);
  const files = await forge.transform(createMcpTransformer(doc, { ...flags, serverName: flags.name, projectConfig: { name: probe.serverName, baseUrl: probe.baseUrl, ...(config.envPrefix !== undefined ? { envPrefix: config.envPrefix } : {}), include: config.include ?? [], exclude: config.exclude ?? [] }, runtimeSource: await runtimeSource() }));
  await assertOutputDoesNotContainInputs(outDir, [{ label: 'spec', path: spec }, ...((config.overlays ?? []).map((path) => ({ label: 'overlay', path }))), { label: 'config', path: configPath }]);
  // Overwrite only the files the generator owns; a recursive clean used to
  // erase node_modules and leave an installed server unstartable (#164).
  await forge.finalize(outDir, files);
  const toolCount = JSON.parse(files.find((f) => f.path === 'operations.json')?.content ?? '{}').tools?.length ?? 0;
  console.log(`Generated ${toolCount} tools in ${outDir}`);
  const installed = await access(join(outDir, 'node_modules')).then(() => true, () => false);
  console.log(installed ? `Next: cd ${outDir} && npm start` : `Next: cd ${outDir} && npm install && npm start`);
  if (probe.auth.schemes.length > 0) {
    console.log(`Auth: set ${probe.auth.schemes.map((s) => s.envVar).join(', ')} (see .env.example)`);
  }
  if (!probe.baseUrl) {
    console.log(`Note: the spec declares no server URL - set ${probe.auth.baseUrlEnvVar} or regenerate with --base-url.`);
  }
  if (probe.webhooks.length > 0) {
    console.log(`Note: the spec declares ${probe.webhooks.length} webhook${probe.webhooks.length === 1 ? '' : 's'} - listed in the generated README, not exposed as tools.`);
  }
  if (probe.jsonSchemaDialect && probe.jsonSchemaDialect !== DEFAULT_31_DIALECT) {
    console.log(`Note: the spec declares a custom JSON Schema dialect (${probe.jsonSchemaDialect}); tool argument schemas are approximated as standard JSON Schema.`);
  }
}

async function cmdServe(spec: string, flags: ManifestOptions & { name?: string; transport?: string; port?: string }, config: ProjectConfig): Promise<void> {
  const doc = await loadEffectiveSpec(spec, config.overlays ?? []);
  await init(doc);
  const manifest = buildManifest(doc, { serverName: flags.name, baseUrl: flags.baseUrl, envPrefix: flags.envPrefix, include: flags.include, exclude: flags.exclude });
  for (const warning of manifest.auth.warnings) console.error(`warning: ${warning}`);
  for (const warning of manifest.warnings ?? []) console.error(`warning: ${warning}`);
  const runtimeUrl = new URL('../runtime/server.mjs', import.meta.url).href;
  const runtime = (await import(runtimeUrl)) as {
    runServer: (manifest: import('./manifest.js').Manifest) => Promise<void>;
    runHttpServer: (manifest: import('./manifest.js').Manifest, options: { port: number }) => Promise<unknown>;
  };
  if (flags.transport === 'http') await runtime.runHttpServer(manifest, { port: flags.port === undefined ? 3000 : Number(flags.port) });
  else await runtime.runServer(manifest);
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
      transport: { type: 'string' },
      port: { type: 'string' },
      'env-prefix': { type: 'string' },
      overlay: { type: 'string', multiple: true },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      config: { type: 'string' },
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
  const { options, config } = resolveConfig(await readProjectConfig(values.config), { name: values.name, baseUrl: values['base-url'], envPrefix: values['env-prefix'], overlays: values.overlay, include: values.include, exclude: values.exclude });
  const flags = { out: values.out, name: options.serverName, baseUrl: options.baseUrl, envPrefix: options.envPrefix, transport: values.transport, port: values.port, include: options.include, exclude: options.exclude };
  if (flags.transport && !['stdio', 'http'].includes(flags.transport)) fail('--transport must be stdio or http');
  if (command !== 'serve' && (flags.transport || flags.port)) fail('--transport and --port are only valid with serve');
  if (flags.port && (flags.transport !== 'http' || !/^(0|[1-9][0-9]*)$/.test(flags.port) || Number(flags.port) > 65535)) {
    fail('--port requires --transport http and an integer between 0 and 65535');
  }

  if (values['poll-interval'] && (!values.watch || !/^https?:\/\//i.test(spec))) {
    fail('--poll-interval requires --watch and an HTTP(S) spec URL');
  }
  if (values.watch && command === 'serve') fail('--watch is only supported by generate');
  if (values.watch) {
    if (flags.out) await assertOutputDoesNotContainInputs(flags.out, [{ label: 'spec', path: spec }, ...((config.overlays ?? []).map((path) => ({ label: 'overlay', path }))), { label: 'config', path: values.config }]);
    const seconds = values['poll-interval'] === undefined ? 30 : Number(values['poll-interval']);
    if (!Number.isFinite(seconds) || seconds <= 0) fail('--poll-interval must be a positive number of seconds');
    const handle = await watchSpec(spec, () => cmdGenerate(spec, flags, config, values.config), { pollIntervalMs: seconds * 1000, additionalInputs: config.overlays ?? [] });
    process.once('SIGINT', () => { handle.close(); process.exit(0); });
    process.once('SIGTERM', () => { handle.close(); process.exit(0); });
  } else if (command === 'serve') {
    await cmdServe(spec, flags, config);
  } else {
    await cmdGenerate(spec, flags, config, values.config);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
