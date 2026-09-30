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
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_CHARS = 50_000;
const DEFAULT_MAX_BINARY_BYTES = 4 * 1024 * 1024;

function envLimit(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Text responses longer than this are truncated (SPEC2MCP_MAX_RESPONSE_CHARS). */
const MAX_RESPONSE_CHARS = envLimit('SPEC2MCP_MAX_RESPONSE_CHARS', DEFAULT_MAX_RESPONSE_CHARS);
/** Binary payloads larger than this are summarised instead of returned (SPEC2MCP_MAX_BINARY_BYTES). */
const MAX_BINARY_BYTES = envLimit('SPEC2MCP_MAX_BINARY_BYTES', DEFAULT_MAX_BINARY_BYTES);

/** Raised when a tool argument cannot be encoded into the request body. */
class ToolArgumentError extends Error {}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/** SDK clients require structuredContent on successful calls with outputSchema.
 * Keep the upstream content, but mark an unrepresentable response as a tool error. */
function outputFallback(result, tool, note) {
  if (!tool.outputSchema) return result;
  return {
    ...result,
    isError: true,
    content: [...result.content, { type: 'text', text: `[outputSchema fallback: ${note}]` }],
  };
}

function setNested(target, fieldPath, value) {
  if (!fieldPath || fieldPath.length === 0) return value;
  let cursor = target;
  // defineProperty, never plain assignment: a segment like "__proto__" must
  // become an own enumerable property (plain assignment would retarget the
  // prototype and silently drop the field from the JSON body).
  const define = (obj, key, val) =>
    Object.defineProperty(obj, key, { value: val, writable: true, enumerable: true, configurable: true });
  for (let i = 0; i < fieldPath.length - 1; i++) {
    const key = fieldPath[i];
    if (!Object.prototype.hasOwnProperty.call(cursor, key) || typeof cursor[key] !== 'object' || cursor[key] === null) {
      define(cursor, key, {});
    }
    cursor = cursor[key];
  }
  define(cursor, fieldPath[fieldPath.length - 1], value);
  return target;
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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
  // Canonical base64 only: correct alphabet, no whitespace, padding solely at
  // the end. Node's decoder silently ignores invalid characters, so corrupt
  // uploads would otherwise be "accepted" as different bytes than supplied.
  if (typeof contentBase64 !== 'string' || !BASE64_RE.test(contentBase64)) {
    throw new ToolArgumentError(
      `Argument "${arg.name}": contentBase64 must be a canonical base64 string (no whitespace, correct padding).`,
    );
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.toString('base64') !== contentBase64) {
    throw new ToolArgumentError(`Argument "${arg.name}": contentBase64 does not round-trip; refusing to upload corrupt data.`);
  }
  const filename = typeof value.filename === 'string' && value.filename.length > 0 ? value.filename : (arg.apiName ?? arg.name);
  const mimeType = typeof value.mimeType === 'string' && value.mimeType.length > 0 ? value.mimeType : (arg.defaultMimeType ?? 'application/octet-stream');
  return { bytes, filename, mimeType };
}

/** Decode a canonical base64 body before fetch can coerce it to UTF-8. */
function binaryBody(value) {
  if (typeof value !== 'string' || !BASE64_RE.test(value)) {
    throw new ToolArgumentError('Argument "body" must be a canonical base64 string (no whitespace, correct padding).');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new ToolArgumentError('Argument "body" does not round-trip as base64; refusing to send corrupt data.');
  }
  return bytes;
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
      form.append(arg.apiName ?? arg.name, new Blob([part.bytes], { type: part.mimeType }), part.filename);
    } else if (typeof value === 'object' && value !== null) {
      form.append(arg.apiName ?? arg.name, JSON.stringify(value));
    } else {
      form.append(arg.apiName ?? arg.name, String(value));
    }
    parts++;
  }
  return parts > 0 ? form : undefined;
}

/** Encode flat OpenAPI form objects using per-property encoding rules. */
function formBody(value, encodings = {}) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolArgumentError('Argument "body" must be an object for application/x-www-form-urlencoded.');
  }
  const params = new URLSearchParams();
  for (const [key, encoding] of Object.entries(encodings)) {
    if (encoding?.unsupported || !['form', 'spaceDelimited', 'pipeDelimited'].includes(encoding?.style ?? 'form')) {
      throw new ToolArgumentError(`Unsupported form encoding for field "${key}".`);
    }
  }
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    const encoding = encodings[key] ?? {};
    if (encoding.unsupported) {
      throw new ToolArgumentError(`Unsupported form encoding for field "${key}": ${encoding.unsupported}.`);
    }
    const style = encoding.style ?? 'form';
    const explode = encoding.explode ?? (style === 'form');
    if (!['form', 'spaceDelimited', 'pipeDelimited'].includes(style)) {
      throw new ToolArgumentError(`Unsupported form encoding style "${style}" for field "${key}".`);
    }
    const values = Array.isArray(field) ? field : [field];
    for (const item of values) {
      if (item === null || typeof item === 'object') {
        throw new ToolArgumentError(`Form field "${key}" must be a scalar or array of scalars.`);
      }
    }
    if (!Array.isArray(field)) {
      params.append(key, String(field));
    } else if (style === 'form' && explode) {
      for (const item of values) params.append(key, String(item));
    } else {
      const separator = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
      params.append(key, values.map(String).join(separator));
    }
  }
  return params.toString();
}

/** Pick the tool's active auth schemes (#146). Security requirement objects
 * in an array are OR alternatives: when the manifest preserves them, use the
 * first alternative whose schemes ALL have configured environment values, so
 * a usable later route is not discarded with an unset first one. When no
 * alternative is fully configured, keep the first (legacy behavior: send
 * anonymously and let the API answer 401). */
function selectAuthSchemes(manifest, tool) {
  const all = manifest.auth?.schemes ?? [];
  if (tool.authAlternatives !== undefined) {
    const byName = new Map(all.map((scheme) => [scheme.schemeName, scheme]));
    const configured = (names) => names.every((name) => {
      const scheme = byName.get(name);
      return scheme && process.env[scheme.envVar];
    });
    const chosen = tool.authAlternatives.find(configured) ?? tool.authAlternatives[0] ?? [];
    return all.filter((scheme) => chosen.includes(scheme.schemeName));
  }
  // Older manifests have no per-tool selection and retain their root-level auth.
  return tool.authSchemeNames === undefined
    ? all
    : all.filter((scheme) => tool.authSchemeNames.includes(scheme.schemeName));
}

/** Apply the manifest's auth schemes. Missing env vars are skipped, not
 * fatal: many APIs allow anonymous calls, and an API that needs auth answers
 * with its own 401. Unset vars are listed once at server start. */
function applyAuth(manifest, tool, url, headers) {
  const schemes = selectAuthSchemes(manifest, tool);
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
        // set(), not append(): a caller-supplied query argument of the same
        // name must never shadow (or duplicate alongside) the credential.
        url.searchParams.set(scheme.queryName, value);
        break;
    }
  }
  return null;
}

/** Serialize OpenAPI path/query/header parameters before URL or header encoding. */
function parameterStyle(arg) {
  return arg.style ?? (arg.location === 'query' ? 'form' : 'simple');
}
function parameterParts(arg, value) {
  const style = parameterStyle(arg);
  const explode = arg.explode ?? (style === 'form');
  const scalar = (item) => String(item);
  if (Array.isArray(value)) {
    const items = value.map(scalar);
    if (style === 'spaceDelimited') return [items.join(' ')];
    if (style === 'pipeDelimited') return [items.join('|')];
    if (style === 'form' && explode) return items;
    return [items.join(',')];
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (style === 'deepObject' && arg.location === 'query') return entries.map(([k, v]) => [k, scalar(v)]);
    if (style === 'form' && explode) return entries.map(([k, v]) => [k, scalar(v)]);
    if (style === 'simple' && explode) return [entries.map(([k, v]) => `${k}=${scalar(v)}`).join(',')];
    return [entries.flatMap(([k, v]) => [k, scalar(v)]).join(',')];
  }
  return [scalar(value)];
}
/** Reserved expansion, with query syntax delimiters kept percent-encoded. */
function encodeReservedQueryValue(value) {
  return encodeURIComponent(value)
    .replace(/%[0-9A-F]{2}/gi, (escape) => {
      const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      // &[+#[ ] and percent not part of an encoded triple must remain encoded.
      return '/?:@$,;='.includes(char) ? char : escape;
    })
    // RFC6570 reserved expansion keeps already-encoded triples intact.
    .replace(/%25([0-9A-F]{2})/gi, '%$1');
}

function pathParameter(arg, value) {
  const style = parameterStyle(arg);
  const explode = arg.explode ?? false;
  const encode = (item) => encodeURIComponent(String(item));
  if (Array.isArray(value)) {
    const items = value.map(encode);
    if (style === 'label') return `.${items.join(explode ? '.' : ',')}`;
    if (style === 'matrix') {
      const name = encode(arg.apiName ?? arg.name);
      return explode ? items.map((item) => `;${name}=${item}`).join('') : `;${name}=${items.join(',')}`;
    }
    return items.join(',');
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (style === 'matrix') {
      const name = encode(arg.apiName ?? arg.name);
      return explode
        ? entries.map(([k, v]) => `;${encode(k)}=${encode(v)}`).join('')
        : `;${name}=${entries.flatMap(([k, v]) => [encode(k), encode(v)]).join(',')}`;
    }
    const encoded = explode
      ? entries.map(([k, v]) => `${encode(k)}=${encode(v)}`).join(style === 'label' ? '.' : ',')
      : entries.flatMap(([k, v]) => [encode(k), encode(v)]).join(',');
    return style === 'label' ? `.${encoded}` : encoded;
  }
  const encoded = encode(value);
  if (style === 'label') return `.${encoded}`;
  if (style === 'matrix') return `;${encode(arg.apiName ?? arg.name)}=${encoded}`;
  return encoded;
}

/** The response content-type, lower-cased, without any charset parameter. */
function baseContentType(headerValue) {
  return (headerValue ?? '').split(';', 1)[0].trim().toLowerCase();
}

// The exact JSON media predicate (#116): application/json or a +json
// suffix. src/manifest.ts isJsonMediaType carries the same one rule - keep
// them in sync. A looser match would advertise schemas for bodies that are
// not single JSON documents (e.g. application/json-seq).
function isJsonType(contentType) {
  return contentType === 'application/json' || contentType.endsWith('+json');
}

/** Types safely rendered as text (and truncated) rather than as binary content. */
function isTextLikeType(contentType) {
  return (
    isJsonType(contentType) ||
    contentType.startsWith('text/') ||
    contentType === 'application/xml' ||
    contentType.endsWith('+xml') ||
    contentType === 'application/javascript' ||
    contentType === 'image/svg+xml' ||
    contentType === 'application/x-www-form-urlencoded'
  );
}

/** SVG is text; every other image type maps to MCP image content. */
function isImageType(contentType) {
  return contentType.startsWith('image/') && contentType !== 'image/svg+xml';
}

function isAudioType(contentType) {
  return contentType.startsWith('audio/');
}

function truncateText(text) {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_RESPONSE_CHARS)}\n\n[truncated: the response is ${text.length} characters; showing the first ${MAX_RESPONSE_CHARS}. Set SPEC2MCP_MAX_RESPONSE_CHARS to raise the limit.]`;
}

/** Replace the response body when it is too large to ship back as base64. */
function oversizedBinaryResult(byteLength, contentType) {
  return textResult(
    `[binary response omitted: ${byteLength} bytes of ${contentType || 'unknown type'} exceeds the ${MAX_BINARY_BYTES}-byte limit. Set SPEC2MCP_MAX_BINARY_BYTES to raise it.]`,
  );
}

/** Compile once per tool at startup with the same validator used by MCP SDK
 * clients. Avoid a second JSON Schema implementation with divergent formats,
 * equality, Unicode length and numeric range rules. */
const sdkOutputValidator = new AjvJsonSchemaValidator();
function compileOutputValidator(schema) {
  const validate = sdkOutputValidator.getValidator(schema);
  return (value) => validate(value).valid;
}

export { compileOutputValidator };

/** Ignore quoted text; inspect numeric tokens only after JSON syntax validation. */
function hasUnsafeIntegerToken(json) {
  const unquoted = json.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const tokens = unquoted.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  return tokens.some(token => {
    const number = Number(token);
    return !Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number));
  });
}

async function executeTool(manifest, tool, args, validateOutput) {
  // Only body parent/leaf paths can cover each other. Query/header/path
  // args with the same visible prefix are separate wire parameters (#123).
  const supplied = tool.args.filter((arg) => args[arg.name] !== undefined);
  const prefix = (a, b) => a.length <= b.length && a.every((segment, i) => segment === b[i]);
  const covered = (required) => supplied.some((given) => {
    if (required.name === given.name) return true;
    if (required.location !== 'body' || given.location !== 'body') return false;
    const a = required.apiFieldPath;
    const b = given.apiFieldPath;
    return Array.isArray(a) && a.length > 0 && Array.isArray(b) && b.length > 0 &&
      (prefix(a, b) || prefix(b, a));
  });
  const missing = tool.args.filter((arg) => arg.required && !covered(arg)).map((arg) => arg.name);
  if (missing.length > 0) {
    return errorResult(`Missing required argument(s): ${missing.join(', ')}`);
  }

  const baseUrl = process.env[manifest.auth?.baseUrlEnvVar] || tool.baseUrl || manifest.baseUrl;
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
      // Check the encoded wire segment, not String(value): label-style empty
      // arrays/objects serialize as '.', which WHATWG URL then normalizes.
      let segment;
      try { segment = pathParameter(arg, value); }
      catch (error) {
        if (error instanceof URIError) return errorResult(`Invalid path argument "${arg.name}": malformed Unicode cannot be encoded.`);
        throw error;
      }
      if (segment === '.' || segment === '..') {
        return errorResult(`Invalid path argument "${arg.name}": dot segments are not allowed.`);
      }
      path = path.replaceAll(`{${arg.apiName ?? arg.name}}`, () => segment);
    }
  }
  let url;
  let headers;
  const reservedQuery = [];
  try {
    url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
    for (const arg of tool.args) {
      const value = args[arg.name];
      if (value === undefined) continue;
      if (arg.location === 'query') {
        const wireName = arg.apiName ?? arg.name;
        const style = parameterStyle(arg);
        const parts = parameterParts(arg, value);
        for (const part of parts) {
          const key = Array.isArray(part) ? (style === 'deepObject' ? `${wireName}[${part[0]}]` : part[0]) : wireName;
          const item = Array.isArray(part) ? part[1] : part;
          if (arg.allowReserved === true) reservedQuery.push([key, item]);
          else url.searchParams.append(key, item);
        }
      }
    }

    headers = new Headers();
    const declaredResponses = tool.responseContentTypes;
    headers.set('accept', declaredResponses && declaredResponses.length > 0 ? declaredResponses.join(', ') : 'application/json');
    for (const arg of tool.args) {
      const value = args[arg.name];
      if (value === undefined || arg.location !== 'header') continue;
      headers.set(arg.apiName ?? arg.name, parameterParts(arg, value).map((part) => Array.isArray(part) ? part.join('=') : part).join(','));
    }

    // Cookie parameters serialize as `name=value` pairs joined by "; " in a
    // single Cookie header (OpenAPI cookie style is form). An existing
    // Cookie header (an explicit header argument) is kept and extended, not
    // overwritten (#138).
    const cookiePairs = [];
    for (const arg of tool.args) {
      const value = args[arg.name];
      if (value === undefined || arg.location !== 'cookie') continue;
      const wireName = arg.apiName ?? arg.name;
      for (const part of parameterParts(arg, value)) {
        if (Array.isArray(part)) cookiePairs.push(`${part[0]}=${encodeURIComponent(part[1])}`);
        else cookiePairs.push(`${wireName}=${encodeURIComponent(part)}`);
      }
    }
    if (cookiePairs.length > 0) {
      const existing = headers.get('cookie');
      headers.set('cookie', existing ? `${existing}; ${cookiePairs.join('; ')}` : cookiePairs.join('; '));
    }

    applyAuth(manifest, tool, url, headers);
    // Append only after every searchParams mutation: URLSearchParams re-encodes
    // the entire query, erasing reserved expansion. API-key params keep priority.
    const activeQueryKeys = new Set(selectAuthSchemes(manifest, tool)
      .filter((scheme) => scheme.kind === 'apikey-query' && process.env[scheme.envVar])
      .map((scheme) => scheme.queryName));
    for (const [key, item] of reservedQuery) {
      if (activeQueryKeys.has(key)) continue;
      const pair = `${encodeURIComponent(key)}=${encodeReservedQueryValue(item)}`;
      url.search += `${url.search ? '&' : ''}${pair}`;
    }
  } catch {
    return errorResult('Invalid request URL or header argument.');
  }

  let body;
  const bodyArgs = tool.args.filter((a) => a.location === 'body');
  if (bodyArgs.length > 0 && bodyArgs.some((a) => args[a.name] !== undefined)) {
    if (tool.contentType === 'multipart/form-data') {
      try {
        body = buildFormBody(tool, args);
      } catch (err) {
        if (err instanceof ToolArgumentError) return errorResult(err.message);
        throw err;
      }
    } else {
      // A raw body is identified by shape, never by name: it is the single
      // body arg with no field path. Its input name may have been
      // disambiguated (a path/query param literally named "body" renames the
      // raw arg to body_body), so matching name === 'body' here would send {}.
      const rawArg =
        bodyArgs.length === 1 && (!bodyArgs[0].apiFieldPath || bodyArgs[0].apiFieldPath.length === 0)
          ? bodyArgs[0]
          : undefined;
      if (rawArg) {
        const raw = args[rawArg.name];
        if (tool.contentType && !isTextLikeType(baseContentType(tool.contentType))) {
          try {
            body = binaryBody(raw);
          } catch (err) {
            if (err instanceof ToolArgumentError) return errorResult(err.message);
            throw err;
          }
        } else if (baseContentType(tool.contentType) === 'application/x-www-form-urlencoded') {
          try {
            body = formBody(raw, tool.formEncoding);
          } catch (err) {
            if (err instanceof ToolArgumentError) return errorResult(err.message);
            throw err;
          }
        } else if (baseContentType(tool.contentType).endsWith('xml') && typeof raw !== 'string') {
          return errorResult('Argument "body" must be a pre-serialized XML string.');
        } else {
          body = isJsonType(baseContentType(tool.contentType)) ? JSON.stringify(raw) : (typeof raw === 'string' ? raw : JSON.stringify(raw));
        }
      } else {
        const obj = {};
        for (const arg of bodyArgs) {
          const value = args[arg.name];
          if (value === undefined) continue;
          if (arg.apiFieldPath && arg.apiFieldPath.length > 0) setNested(obj, arg.apiFieldPath, value);
        }
        body = JSON.stringify(obj);
      }
    }
    // FormData sets its own content-type with the multipart boundary.
    if (body !== undefined && !(body instanceof FormData)) {
      try {
        headers.set('content-type', tool.contentType ?? 'application/json');
      } catch {
        return errorResult('Invalid request Content-Type header.');
      }
    }
  }
  // requestBody.required is independent of property.required. A required
  // object with only optional fields still needs an on-wire empty body.
  if (body === undefined && tool.requiredEmptyObject) {
    if (tool.contentType === 'multipart/form-data') {
      body = new FormData();
    } else {
      body = '{}';
      headers.set('content-type', tool.contentType ?? 'application/json');
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method: tool.method,
      headers,
      body,
      // Never forward credentials or request bodies to an upstream redirect target.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return errorResult('Request failed while connecting to the API. Check the base URL and network settings.');
  }

  if (res.status >= 300 && res.status < 400) {
    return errorResult(`HTTP ${res.status} redirect not followed to protect request credentials and body.`);
  }

  const contentTypeHeader = res.headers.get('content-type');
  const contentType = baseContentType(contentTypeHeader);
  let bytes;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return errorResult(`Failed to read the response body: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    let detail;
    try {
      detail = isTextLikeType(contentType)
        ? truncateText(renderText(bytes, contentType, contentTypeHeader))
        : `[binary body: ${bytes.length} bytes of ${contentType || 'unknown type'}]`;
    } catch { detail = `[undecodable body: ${bytes.length} bytes of ${contentType || 'unknown type'}]`; }
    return errorResult(`HTTP ${res.status} ${res.statusText}\n${detail}`.trim());
  }

  if (bytes.length === 0) {
    return outputFallback(textResult(`(empty response, HTTP ${res.status})`), tool, 'empty upstream response has no structured content');
  }
  if (isImageType(contentType) || isAudioType(contentType)) {
    if (bytes.length > MAX_BINARY_BYTES) return outputFallback(oversizedBinaryResult(bytes.length, contentType), tool, 'oversized binary response omitted');
    return outputFallback({ content: [{ type: isImageType(contentType) ? 'image' : 'audio', data: bytes.toString('base64'), mimeType: contentType }] }, tool, 'non-JSON response has no structured content');
  }
  if (!isTextLikeType(contentType)) {
    if (bytes.length > MAX_BINARY_BYTES) return outputFallback(oversizedBinaryResult(bytes.length, contentType), tool, 'oversized binary response omitted');
    return outputFallback({
      content: [
        {
          type: 'resource',
          resource: { uri: `urn:uuid:${randomUUID()}`, mimeType: contentType || 'application/octet-stream', blob: bytes.toString('base64') },
        },
      ],
    }, tool, 'non-JSON response has no structured content');
  }

  let parsedJson;
  if (isJsonType(contentType)) {
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      parsedJson = JSON.parse(decoded);
      if (hasUnsafeIntegerToken(decoded)) {
        return {
          ...textResult(`${truncateText(decoded)}\n\n[precision warning: JSON numeric precision cannot be preserved in structured content; original JSON text retained]`),
          ...(tool.outputSchema ? { isError: true } : {}),
        };
      }
    } catch {
      // A bounded preview is diagnostic only; replacement characters here
      // cannot turn malformed UTF-8 into a successful JSON response.
      const preview = truncateText(bytes.toString('utf8'));
      return errorResult(`HTTP ${res.status} ${res.statusText} declared JSON but the body is not valid JSON (invalid UTF-8 or JSON syntax).\n${preview}`.trim());
    }
  }
  let rendered;
  try { rendered = isJsonType(contentType) ? JSON.stringify(parsedJson, null, 2) : renderText(bytes, contentType, contentTypeHeader); }
  catch {
    if (isXmlType(contentType)) {
      return errorResult(`HTTP ${res.status} ${res.statusText} declared XML but its text encoding could not be decoded.`);
    }
    const charset = declaredCharset(contentTypeHeader);
    return errorResult(`HTTP ${res.status} ${res.statusText} response text could not be decoded${charset ? ` with the declared charset "${charset}"` : ''}.`);
  }
  const result = textResult(truncateText(rendered));
  // Successful calls advertising outputSchema must have valid structuredContent.
  // A drifted, truncated or non-JSON upstream response stays visible as a tool
  // error, rather than violating the MCP client protocol with text-only success.
  if (tool.outputSchema) {
    if (!isJsonType(contentType)) {
      return outputFallback(result, tool, 'non-JSON response has no structured content');
    }
    const parsed = parsedJson; // decoded and parsed without UTF-8 replacement above
    const structured = tool.outputWrap
      ? { result: parsed }
      : (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined);
    if (!structured) {
      return outputFallback(result, tool, 'JSON response is not an object required by outputSchema');
    }
    if (validateOutput && !validateOutput(structured)) {
      console.error(`${manifest.serverName}: ${tool.name}: response does not match its outputSchema; returning tool error`);
      return outputFallback(result, tool, 'response does not match the advertised outputSchema');
    }
    if (JSON.stringify(structured).length > MAX_RESPONSE_CHARS) {
      console.error(`${manifest.serverName}: ${tool.name}: structuredContent exceeds SPEC2MCP_MAX_RESPONSE_CHARS; returning tool error`);
      return outputFallback(result, tool, 'structured response exceeds SPEC2MCP_MAX_RESPONSE_CHARS');
    }
    result.structuredContent = structured;
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
    tools: manifest.tools.filter((tool) => selected(tool, config)).map((tool) => {
      // An explicit config base URL is a global operator override.
      if (config.baseUrl === undefined) return tool;
      const { baseUrl: _scopedBaseUrl, ...rest } = tool;
      return rest;
    }),
  };
}

function isXmlType(contentType) {
  return contentType === 'application/xml' || contentType === 'text/xml' || contentType.endsWith('+xml');
}

/** The charset parameter of a content-type header, quotes stripped. */
function declaredCharset(contentTypeHeader) {
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentTypeHeader ?? '');
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** Decode XML without replacement characters. HTTP charset takes precedence;
 * otherwise use BOM, then the ASCII-compatible XML declaration. */
function decodeXml(bytes, contentTypeHeader) {
  let encoding = declaredCharset(contentTypeHeader);
  let offset = 0;
  if (!encoding) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { encoding = 'utf-8'; offset = 3; }
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
    else {
      const head = bytes.subarray(0, Math.min(bytes.length, 256)).toString('latin1');
      encoding = /^<\?xml\s[^?]*?encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1] ?? 'utf-8';
    }
  }
  return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
}

/** Decode non-XML text. A declared charset is honored and decoded strictly:
 * an unsupported label or invalid bytes throw, which the caller surfaces as
 * an explicit tool error instead of silently replacing bytes (#131).
 * Undeclared text uses strict UTF-8, never silent byte replacement. */
function decodeDeclaredText(bytes, contentTypeHeader) {
  const charset = declaredCharset(contentTypeHeader);
  return new TextDecoder(charset ?? 'utf-8', { fatal: true }).decode(bytes);
}

/** Decode a text response body, pretty-printing JSON payloads. */
function renderText(bytes, contentType, contentTypeHeader) {
  const text = isXmlType(contentType)
    ? decodeXml(bytes, contentTypeHeader) : decodeDeclaredText(bytes, contentTypeHeader);
  if (isJsonType(contentType) && text.length > 0) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function createMcpServer(manifest) {
  const server = new Server(
    { name: manifest.serverName, version: manifest.apiVersion },
    { capabilities: { tools: {} } },
  );

  const byName = new Map(manifest.tools.map((t) => [t.name, t]));
  // Compile outputSchema validators once at server start: the manifest's
  // schemas are already dereferenced and size-capped at generation time.
  // Reusing compiled SDK/Ajv validators keeps call-time work payload-bound.
  const outputValidators = new Map();
  for (const tool of manifest.tools) {
    if (!tool.outputSchema) continue;
    try {
      outputValidators.set(tool.name, compileOutputValidator(tool.outputSchema));
    } catch (err) {
      // A schema with invalid keywords (bad regex pattern, non-array enum,
      // string minimum, ...) survives generation but Ajv refuses to compile
      // it. One bad tool must never take the server down: strip structured
      // output for that tool and keep serving the rest.
      console.error(
        `${manifest.serverName}: ${tool.name}: outputSchema failed to compile (${err instanceof Error ? err.message : String(err)}); serving the tool without structured output`,
      );
      delete tool.outputSchema;
    }
  }

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
    return executeTool(manifest, tool, request.params.arguments ?? {}, outputValidators.get(request.params.name));
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
      try {
        // createMcpServer compiles per-tool validators; a residual failure
        // here must answer 500, not kill the process with an unhandled throw.
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
