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

/** Raised when a tool argument cannot be encoded into the request body. */
class ToolArgumentError extends Error {}

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

const BASE64_RE = /^[A-Za-z0-9+/=\s]*$/;

/**
 * Validate a binary multipart argument ({ contentBase64, filename?,
 * mimeType? }) and decode it into bytes ready for a FormData file part.
 */
function filePart(arg, value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolArgumentError(
      `Argument "${arg.name}" is a file upload: pass an object with a contentBase64 property (base64-encoded file content), plus optional filename and mimeType.`,
    );
  }
  const contentBase64 = value.contentBase64;
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0 || !BASE64_RE.test(contentBase64)) {
    throw new ToolArgumentError(`Argument "${arg.name}": contentBase64 must be a non-empty base64 string.`);
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  const filename = typeof value.filename === 'string' && value.filename.length > 0 ? value.filename : arg.name;
  const mimeType = typeof value.mimeType === 'string' && value.mimeType.length > 0 ? value.mimeType : 'application/octet-stream';
  return { bytes, filename, mimeType };
}

/**
 * Encode body arguments as a real multipart/form-data payload. Binary args
 * become file parts; object/array args are JSON-serialised into their form
 * field; everything else is stringified. Returns undefined when no body
 * argument was supplied, so optional-field forms send no body at all.
 */
function buildFormBody(tool, args) {
  const form = new FormData();
  let parts = 0;
  for (const arg of tool.args) {
    if (arg.location !== 'body') continue;
    const value = args[arg.name];
    if (value === undefined) continue;
    if (arg.binary) {
      const part = filePart(arg, value);
      form.append(arg.name, new Blob([part.bytes], { type: part.mimeType }), part.filename);
    } else if (typeof value === 'object' && value !== null) {
      form.append(arg.name, JSON.stringify(value));
    } else {
      form.append(arg.name, String(value));
    }
    parts++;
  }
  return parts > 0 ? form : undefined;
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
    if (tool.contentType === 'multipart/form-data') {
      try {
        body = buildFormBody(tool, args);
      } catch (err) {
        if (err instanceof ToolArgumentError) return errorResult(err.message);
        throw err;
      }
    } else if (tool.requestBodyIsArray || tool.args.length === 1) {
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
    // FormData sets its own content-type with the multipart boundary.
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set('content-type', tool.contentType ?? 'application/json');
    }
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
  let parsed;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json') && text.length > 0) {
    try {
      parsed = JSON.parse(text);
      rendered = JSON.stringify(parsed, null, 2);
    } catch {
      rendered = text;
    }
  }
  if (!res.ok) {
    return errorResult(`HTTP ${res.status} ${res.statusText}\n${rendered}`.trim());
  }
  const result = textResult(rendered.length > 0 ? rendered : `(empty response, HTTP ${res.status})`);
  // Tools with a manifest outputSchema also return structuredContent (MCP
  // spec). The text content stays for clients without structured support.
  // Degrade silently to text-only when the body didn't parse as JSON or the
  // API returned a shape the schema can't hold.
  if (tool.outputSchema && parsed !== undefined) {
    let structured;
    if (tool.outputWrap) {
      structured = { result: parsed ?? null };
    } else if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      structured = parsed;
    }
    if (structured) result.structuredContent = structured;
  }
  return result;
}

/** Runtime config can narrow the generated tool set without rebuilding. */
function selected(tool, config) {
  const matches = (selector) => {
    const tagOnly = selector.startsWith('tag:');
    const operationOnly = selector.startsWith('operation:');
    const value = selector.slice(tagOnly ? 4 : operationOnly ? 10 : 0);
    if (!value) return false;
    if (!operationOnly && (tool.tags ?? []).includes(value)) return true;
    if (tagOnly) return false;
    const pattern = `^${[...value].map((char) => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$+.()|[\]{}]/g, '\\$&')).join('')}$`;
    return new RegExp(pattern).test(tool.operationId);
  };
  return (!(config.include?.length) || config.include.some(matches)) && !(config.exclude ?? []).some(matches);
}

function withConfig(manifest, config) {
  return {
    ...manifest,
    serverName: config.name ?? manifest.serverName,
    baseUrl: config.baseUrl ?? manifest.baseUrl,
    tools: manifest.tools.filter((tool) => selected(tool, config)),
  };
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
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
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
  let config = {};
  try {
    config = JSON.parse(await readFile(new URL('./spec2mcp.config.json', import.meta.url), 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a JSON object');
    for (const key of ['include', 'exclude']) {
      if (config[key] !== undefined && (!Array.isArray(config[key]) || !config[key].every((item) => typeof item === 'string'))) {
        throw new Error(`${key} must be an array of strings`);
      }
    }
    for (const key of ['name', 'baseUrl']) {
      if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(`${key} must be a string`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Invalid spec2mcp.config.json: ${err.message}`);
  }
  const configured = withConfig(manifest, config);
  const args = process.argv.slice(2);
  if (args[0] === '--transport' && args[1] === 'http' && args.length === 2) {
    await runHttpServer(configured, { port: Number(process.env.PORT || '3000') });
  } else if (args.length === 0 || (args[0] === '--transport' && args[1] === 'stdio' && args.length === 2)) {
    await runServer(configured);
  } else {
    throw new Error('Usage: node server.mjs [--transport stdio|http] (HTTP port: PORT env var)');
  }
}
