/**
 * spec2mcp generated-server runtime.
 *
 * This file is copied verbatim into every generated project next to an
 * operations.json manifest. It registers one MCP tool per manifest entry and
 * executes calls as HTTP requests against the API. The only dependency is
 * @modelcontextprotocol/sdk.
 *
 * It is also imported in-process by `spec2mcp serve`.
 *
 * IMPORTANT: stdout is the MCP protocol channel. Never write logs to stdout.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const REQUEST_TIMEOUT_MS = 30_000;

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function setNested(target, fieldPath, value) {
  if (!fieldPath || fieldPath.length === 0) return value;
  let cursor = target;
  for (let i = 0; i < fieldPath.length - 1; i++) {
    const key = fieldPath[i];
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[fieldPath[fieldPath.length - 1]] = value;
  return target;
}

/** Apply the manifest's auth schemes. Missing env vars are skipped, not
 * fatal: many APIs allow anonymous calls, and an API that needs auth answers
 * with its own 401. Unset vars are listed once at server start. */
function applyAuth(manifest, url, headers) {
  for (const scheme of manifest.auth?.schemes ?? []) {
    const value = process.env[scheme.envVar];
    if (!value) continue;
    switch (scheme.kind) {
      case 'bearer':
        headers.set('authorization', `Bearer ${value}`);
        break;
      case 'basic':
        headers.set('authorization', `Basic ${Buffer.from(value, 'utf8').toString('base64')}`);
        break;
      case 'apikey-header':
        headers.set(scheme.headerName, value);
        break;
      case 'apikey-query':
        url.searchParams.append(scheme.queryName, value);
        break;
    }
  }
  return null;
}

async function executeTool(manifest, tool, args) {
  const missing = tool.args.filter((a) => a.required && args[a.name] === undefined).map((a) => a.name);
  if (missing.length > 0) {
    return errorResult(`Missing required argument(s): ${missing.join(', ')}`);
  }

  const baseUrl = process.env[manifest.auth?.baseUrlEnvVar] || manifest.baseUrl;
  if (!baseUrl) {
    return errorResult(
      `No base URL known for this API. Regenerate with --base-url, or set the ${manifest.auth?.baseUrlEnvVar} environment variable.`,
    );
  }

  let path = tool.path;
  for (const arg of tool.args) {
    const value = args[arg.name];
    if (value === undefined) continue;
    if (arg.location === 'path') {
      path = path.replace(`{${arg.name}}`, encodeURIComponent(String(value)));
    }
  }
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const arg of tool.args) {
    const value = args[arg.name];
    if (value === undefined) continue;
    if (arg.location === 'query') {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(arg.name, String(item));
      } else if (typeof value === 'object' && value !== null) {
        url.searchParams.append(arg.name, JSON.stringify(value));
      } else {
        url.searchParams.append(arg.name, String(value));
      }
    }
  }

  const headers = new Headers();
  headers.set('accept', 'application/json');
  for (const arg of tool.args) {
    const value = args[arg.name];
    if (value === undefined || arg.location !== 'header') continue;
    headers.set(arg.name, String(value));
  }

  applyAuth(manifest, url, headers);

  let body;
  if (tool.args.some((a) => a.location === 'body')) {
    if (tool.requestBodyIsArray || tool.args.length === 1) {
      const raw = args.body;
      body = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
    } else {
      const obj = {};
      for (const arg of tool.args) {
        if (arg.location !== 'body') continue;
        const value = args[arg.name];
        if (value === undefined) continue;
        if (arg.apiFieldPath && arg.apiFieldPath.length > 0) setNested(obj, arg.apiFieldPath, value);
      }
      body = JSON.stringify(obj);
    }
    headers.set('content-type', tool.contentType ?? 'application/json');
  }

  let res;
  try {
    res = await fetch(url, {
      method: tool.method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return errorResult(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  let rendered = text;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json') && text.length > 0) {
    try {
      rendered = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      rendered = text;
    }
  }
  if (!res.ok) {
    return errorResult(`HTTP ${res.status} ${res.statusText}\n${rendered}`.trim());
  }
  return textResult(rendered.length > 0 ? rendered : `(empty response, HTTP ${res.status})`);
}

export async function runServer(manifest) {
  const server = new Server(
    { name: manifest.serverName, version: manifest.apiVersion },
    { capabilities: { tools: {} } },
  );

  const byName = new Map(manifest.tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) return errorResult(`Unknown tool: ${request.params.name}`);
    return executeTool(manifest, tool, request.params.arguments ?? {});
  });

  const unset = (manifest.auth?.schemes ?? []).filter((s) => !process.env[s.envVar]).map((s) => s.envVar);
  if (unset.length > 0) {
    console.error(`${manifest.serverName}: auth env var(s) not set: ${unset.join(', ')} - calls proceed anonymously; the API will 401 if it requires them`);
  }

  await server.connect(new StdioServerTransport());
  console.error(`${manifest.serverName}: ${manifest.tools.length} tools from ${manifest.apiTitle} ${manifest.apiVersion} - MCP server running on stdio`);
}

// Executed directly (generated project): load the sibling manifest and run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestUrl = new URL('./operations.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  await runServer(manifest);
}
