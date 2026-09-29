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
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
function applyAuth(manifest, tool, url, headers) {
  // Older manifests have no per-tool selection and retain their root-level auth.
  const schemes = tool.authSchemeNames === undefined
    ? (manifest.auth?.schemes ?? [])
    : (manifest.auth?.schemes ?? []).filter((scheme) => tool.authSchemeNames.includes(scheme.schemeName));
  for (const scheme of schemes) {
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

  applyAuth(manifest, tool, url, headers);

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

function createMcpServer(manifest) {
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

  return server;
}

export async function runServer(manifest) {
  const server = createMcpServer(manifest);
  warnUnsetAuth(manifest);
  await server.connect(new StdioServerTransport());
  console.error(`${manifest.serverName}: ${manifest.tools.length} tools from ${manifest.apiTitle} ${manifest.apiVersion} - MCP server running on stdio`);
}

function warnUnsetAuth(manifest) {
  const unset = (manifest.auth?.schemes ?? []).filter((s) => !process.env[s.envVar]).map((s) => s.envVar);
  if (unset.length > 0) {
    console.error(`${manifest.serverName}: auth env var(s) not set: ${unset.join(', ')} - calls proceed anonymously; the API will 401 if it requires them`);
  }
}

/** Localhost-only Streamable HTTP endpoint. Each client gets its own MCP server
 * and session; the SDK handles POST responses, GET SSE streams and DELETE. */
export async function runHttpServer(manifest, { port = 3000 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('HTTP port must be an integer between 0 and 65535');
  }
  warnUnsetAuth(manifest);
  const sessions = new Map();
  const httpServer = createServer(async (req, res) => {
    // Reject other hosts even on loopback: browsers can reach localhost via DNS rebinding.
    const host = req.headers.host;
    const boundPort = httpServer.address().port;
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}` && host !== `[::1]:${boundPort}`) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`].includes(origin)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.writeHead(405, { Allow: 'POST, GET, DELETE' }).end();
      return;
    }
    const id = req.headers['mcp-session-id'];
    let entry = typeof id === 'string' ? sessions.get(id) : undefined;
    if (id && !entry) {
      res.writeHead(404).end('Unknown MCP session');
      return;
    }
    if (!entry && req.method !== 'POST') {
      res.writeHead(400).end('MCP session required');
      return;
    }
    if (!entry) {
      const server = createMcpServer(manifest);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => sessions.set(sessionId, { server, transport }),
        onsessionclosed: (sessionId) => sessions.delete(sessionId),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      entry = { server, transport };
      try {
        await server.connect(transport);
      } catch (err) {
        console.error('MCP session setup failed:', err);
        res.writeHead(500).end('MCP session setup failed');
        return;
      }
    }
    try {
      await entry.transport.handleRequest(req, res);
      if (!entry.transport.sessionId) await entry.server.close();
    } catch (err) {
      console.error('MCP HTTP request failed:', err);
      if (!res.headersSent) res.writeHead(500).end('MCP request failed');
      else res.end();
      if (entry.transport.sessionId) sessions.delete(entry.transport.sessionId);
      await entry.server.close();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', resolve);
    });
  } catch (err) {
    httpServer.close();
    throw err;
  }
  console.error(`${manifest.serverName}: ${manifest.tools.length} tools - Streamable HTTP listening at http://127.0.0.1:${httpServer.address().port}/mcp`);
  return httpServer;
}

// Executed directly (generated project): load the sibling manifest and run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestUrl = new URL('./operations.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const args = process.argv.slice(2);
  if (args[0] === '--transport' && args[1] === 'http' && args.length === 2) {
    await runHttpServer(manifest, { port: Number(process.env.PORT || '3000') });
  } else if (args.length === 0 || (args[0] === '--transport' && args[1] === 'stdio' && args.length === 2)) {
    await runServer(manifest);
  } else {
    throw new Error('Usage: node server.mjs [--transport stdio|http] (HTTP port: PORT env var)');
  }
}
