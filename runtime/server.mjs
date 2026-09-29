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
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0 || !BASE64_RE.test(contentBase64)) {
    throw new ToolArgumentError(
      `Argument "${arg.name}": contentBase64 must be a non-empty canonical base64 string (no whitespace, correct padding).`,
    );
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== contentBase64) {
    throw new ToolArgumentError(`Argument "${arg.name}": contentBase64 does not round-trip; refusing to upload corrupt data.`);
  }
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
        // set(), not append(): a caller-supplied query argument of the same
        // name must never shadow (or duplicate alongside) the credential.
        url.searchParams.set(scheme.queryName, value);
        break;
    }
  }
  return null;
}

/** The response content-type, lower-cased, without any charset parameter. */
function baseContentType(headerValue) {
  return (headerValue ?? '').split(';', 1)[0].trim().toLowerCase();
}

function isJsonType(contentType) {
  return contentType === 'application/json' || contentType.endsWith('+json');
}

/** Types safely rendered as text (and truncated) rather than as binary content. */
function isTextLikeType(contentType) {
  return (
    contentType === '' ||
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

/** Structural equality over JSON values, for enum and const checks. */
function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a);
    return aKeys.length === Object.keys(b).length && aKeys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function isObjectValue(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeMatches(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return isObjectValue(value);
    case 'null': return value === null;
    default: return true; // Unknown type keyword: treat as an annotation.
  }
}

function isIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && (part === '0' || !part.startsWith('0')));
}

const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

function isIpv6(value) {
  if (value.length < 2 || value.length > 45) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  let groups = [];
  for (const [i, half] of halves.entries()) {
    if (half === '') continue;
    const parts = half.split(':');
    const last = parts[parts.length - 1];
    if (last.includes('.')) {
      // An embedded IPv4 address may only appear as the final group.
      if (i !== halves.length - 1 || !isIpv4(last)) return false;
      parts.pop();
      groups = groups.concat(parts, ['0', '0']);
    } else {
      groups = groups.concat(parts);
    }
  }
  if (!groups.every((group) => IPV6_GROUP_RE.test(group))) return false;
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDate(value) {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;

function isTimeParts(hour, minute, second) {
  return hour <= 23 && minute <= 59 && second <= 60; // 60: leap second, as ajv-formats allows.
}

function isDateTime(value) {
  const match = DATE_TIME_RE.exec(value);
  if (!match || !isDate(match[1])) return false;
  return isTimeParts(Number(match[2]), Number(match[3]), Number(match[4]));
}

function isUri(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Common OpenAPI string formats, mirroring the formats MCP SDK clients check
 * (ajv-formats, full mode). Each takes an already-confirmed string. */
const STRING_FORMAT_CHECKS = {
  'date-time': isDateTime,
  date: isDate,
  time: (v) => {
    const match = TIME_RE.exec(v);
    return match !== null && isTimeParts(Number(match[1]), Number(match[2]), Number(match[3]));
  },
  email: (v) => v.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(v),
  uri: isUri,
  url: isUri,
  uuid: (v) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v),
  hostname: (v) => v.length <= 253 && /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(v),
  ipv4: isIpv4,
  ipv6: isIpv6,
  byte: (v) => v.length % 4 === 0 && BASE64_RE.test(v),
};

/** Numeric formats from OpenAPI (int32/int64), mirroring ajv-formats. */
const NUMBER_FORMAT_CHECKS = {
  int32: (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647,
  int64: (v) => Number.isSafeInteger(v),
  float: (v) => Number.isFinite(v),
  double: (v) => Number.isFinite(v),
};

/** Compilation depth cap: deeper (hand-written or hostile) schemas compile to
 * pass-through rather than recursing without bound. Generator output is
 * already depth-capped, so this only guards non-generated manifests. */
const MAX_VALIDATOR_DEPTH = 24;

/**
 * Compile a manifest outputSchema into a plain closure `(value) => boolean`,
 * run against candidate structuredContent before it is attached. Compilation
 * walks the schema once (at server start, per tool); the returned closure
 * walks only the response data, so call-time cost stays proportional to the
 * payload. Keywords the compiler does not know are treated as annotations and
 * ignored, matching how lenient validators treat unknown keywords; anything
 * unrecognisable compiles to pass-through.
 */
function compileOutputValidator(schema) {
  return compileSchemaNode(schema, 0);
}

function compileSchemaNode(schema, depth) {
  if (!isObjectValue(schema) || depth > MAX_VALIDATOR_DEPTH) {
    return () => true;
  }
  const checks = [];

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((t) => typeof t === 'string');
    if (types.length > 0) checks.push((v) => types.some((t) => typeMatches(v, t)));
  }
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum;
    checks.push((v) => allowed.some((item) => jsonEqual(item, v)));
  }
  if (Object.hasOwn(schema, 'const')) {
    checks.push((v) => jsonEqual(schema.const, v));
  }

  // String constraints (no-ops on non-strings, per JSON Schema).
  if (typeof schema.minLength === 'number') checks.push((v) => typeof v !== 'string' || v.length >= schema.minLength);
  if (typeof schema.maxLength === 'number') checks.push((v) => typeof v !== 'string' || v.length <= schema.maxLength);
  if (typeof schema.pattern === 'string') {
    let pattern;
    try {
      pattern = new RegExp(schema.pattern);
    } catch {
      pattern = undefined; // Invalid pattern: treat as an annotation.
    }
    if (pattern) checks.push((v) => typeof v !== 'string' || pattern.test(v));
  }

  // Number constraints (no-ops on non-numbers). Both the numeric
  // (draft-06+) and boolean (OpenAPI 3.0) exclusive bound forms.
  if (typeof schema.minimum === 'number') {
    const exclusive = schema.exclusiveMinimum === true;
    checks.push((v) => typeof v !== 'number' || (exclusive ? v > schema.minimum : v >= schema.minimum));
  }
  if (typeof schema.exclusiveMinimum === 'number') checks.push((v) => typeof v !== 'number' || v > schema.exclusiveMinimum);
  if (typeof schema.maximum === 'number') {
    const exclusive = schema.exclusiveMaximum === true;
    checks.push((v) => typeof v !== 'number' || (exclusive ? v < schema.maximum : v <= schema.maximum));
  }
  if (typeof schema.exclusiveMaximum === 'number') checks.push((v) => typeof v !== 'number' || v < schema.exclusiveMaximum);
  if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
    checks.push((v) => typeof v !== 'number' || v % schema.multipleOf === 0);
  }

  // Formats (unknown formats are annotations, as lenient validators treat them).
  if (typeof schema.format === 'string') {
    const stringCheck = STRING_FORMAT_CHECKS[schema.format];
    if (stringCheck) checks.push((v) => typeof v !== 'string' || stringCheck(v));
    const numberCheck = NUMBER_FORMAT_CHECKS[schema.format];
    if (numberCheck) checks.push((v) => typeof v !== 'number' || numberCheck(v));
  }

  // Array constraints.
  if (typeof schema.minItems === 'number') checks.push((v) => !Array.isArray(v) || v.length >= schema.minItems);
  if (typeof schema.maxItems === 'number') checks.push((v) => !Array.isArray(v) || v.length <= schema.maxItems);
  if (schema.uniqueItems === true) {
    checks.push((v) => !Array.isArray(v) || new Set(v.map((item) => JSON.stringify(item))).size === v.length);
  }
  if (schema.items !== undefined) {
    const itemCheck = compileSchemaNode(schema.items, depth + 1);
    checks.push((v) => !Array.isArray(v) || v.every(itemCheck));
  }

  // Object constraints.
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((key) => typeof key === 'string');
    checks.push((v) => !isObjectValue(v) || required.every((key) => Object.hasOwn(v, key)));
  }
  const compiledProps = new Map();
  if (isObjectValue(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      compiledProps.set(key, compileSchemaNode(sub, depth + 1));
    }
  }
  const compiledPatterns = [];
  if (isObjectValue(schema.patternProperties)) {
    for (const [source, sub] of Object.entries(schema.patternProperties)) {
      try {
        compiledPatterns.push([new RegExp(source), compileSchemaNode(sub, depth + 1)]);
      } catch {
        // Invalid pattern: skip it.
      }
    }
  }
  if (compiledProps.size > 0 || compiledPatterns.length > 0) {
    checks.push((v) => {
      if (!isObjectValue(v)) return true;
      for (const [key, check] of compiledProps) {
        if (Object.hasOwn(v, key) && !check(v[key])) return false;
      }
      for (const [re, check] of compiledPatterns) {
        for (const key of Object.keys(v)) {
          if (re.test(key) && !check(v[key])) return false;
        }
      }
      return true;
    });
  }
  if (schema.additionalProperties === false || isObjectValue(schema.additionalProperties)) {
    const known = new Set(compiledProps.keys());
    const extraCheck = isObjectValue(schema.additionalProperties) ? compileSchemaNode(schema.additionalProperties, depth + 1) : undefined;
    checks.push((v) => {
      if (!isObjectValue(v)) return true;
      for (const key of Object.keys(v)) {
        if (known.has(key) || compiledPatterns.some(([re]) => re.test(key))) continue;
        if (!extraCheck) return false;
        if (!extraCheck(v[key])) return false;
      }
      return true;
    });
  }
  if (typeof schema.minProperties === 'number') checks.push((v) => !isObjectValue(v) || Object.keys(v).length >= schema.minProperties);
  if (typeof schema.maxProperties === 'number') checks.push((v) => !isObjectValue(v) || Object.keys(v).length <= schema.maxProperties);

  // Combinators.
  if (Array.isArray(schema.allOf)) {
    const subs = schema.allOf.map((sub) => compileSchemaNode(sub, depth + 1));
    checks.push((v) => subs.every((check) => check(v)));
  }
  if (Array.isArray(schema.anyOf)) {
    const subs = schema.anyOf.map((sub) => compileSchemaNode(sub, depth + 1));
    checks.push((v) => subs.some((check) => check(v)));
  }
  if (Array.isArray(schema.oneOf)) {
    const subs = schema.oneOf.map((sub) => compileSchemaNode(sub, depth + 1));
    checks.push((v) => subs.filter((check) => check(v)).length === 1);
  }
  if (schema.not !== undefined) {
    const sub = compileSchemaNode(schema.not, depth + 1);
    checks.push((v) => !sub(v));
  }

  return (value) => checks.every((check) => check(value));
}

export { compileOutputValidator };

async function executeTool(manifest, tool, args, validateOutput) {
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
      path = path.replace(`{${arg.apiName ?? arg.name}}`, encodeURIComponent(String(value)));
    }
  }
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const arg of tool.args) {
    const value = args[arg.name];
    if (value === undefined) continue;
    if (arg.location === 'query') {
      const wireName = arg.apiName ?? arg.name;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(wireName, String(item));
      } else if (typeof value === 'object' && value !== null) {
        url.searchParams.append(wireName, JSON.stringify(value));
      } else {
        url.searchParams.append(wireName, String(value));
      }
    }
  }

  const headers = new Headers();
  const declaredResponses = tool.responseContentTypes;
  headers.set('accept', declaredResponses && declaredResponses.length > 0 ? declaredResponses.join(', ') : 'application/json');
  for (const arg of tool.args) {
    const value = args[arg.name];
    if (value === undefined || arg.location !== 'header') continue;
    headers.set(arg.apiName ?? arg.name, String(value));
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
    } else if (
      tool.requestBodyIsArray ||
      (tool.args.filter((a) => a.location === 'body').length === 1 &&
        tool.args.some((a) => a.location === 'body' && a.name === 'body' && (!a.apiFieldPath || a.apiFieldPath.length === 0)))
    ) {
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

  const contentType = baseContentType(res.headers.get('content-type'));
  let bytes;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return errorResult(`Failed to read the response body: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const detail = isTextLikeType(contentType)
      ? truncateText(renderText(bytes, contentType))
      : `[binary body: ${bytes.length} bytes of ${contentType || 'unknown type'}]`;
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
          resource: { uri: url.toString(), mimeType: contentType || 'application/octet-stream', blob: bytes.toString('base64') },
        },
      ],
    }, tool, 'non-JSON response has no structured content');
  }

  if (isJsonType(contentType)) {
    try {
      JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      const preview = truncateText(bytes.toString('utf8'));
      return errorResult(
        `HTTP ${res.status} ${res.statusText} declared JSON but the body is not valid JSON (${err instanceof Error ? err.message : String(err)}).\n${preview}`.trim(),
      );
    }
  }
  const result = textResult(truncateText(renderText(bytes, contentType)));
  // Successful calls advertising outputSchema must have valid structuredContent.
  // A drifted, truncated or non-JSON upstream response stays visible as a tool
  // error, rather than violating the MCP client protocol with text-only success.
  if (tool.outputSchema) {
    if (!isJsonType(contentType)) {
      return outputFallback(result, tool, 'non-JSON response has no structured content');
    }
    const parsed = JSON.parse(bytes.toString('utf8')); // checked above
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
    tools: manifest.tools.filter((tool) => selected(tool, config)),
  };
}

/** Decode a text response body, pretty-printing JSON payloads. */
function renderText(bytes, contentType) {
  const text = bytes.toString('utf8');
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
  // schemas are already dereferenced and size-capped at generation time, so
  // call-time validation is plain closures over the response payload.
  const outputValidators = new Map();
  for (const tool of manifest.tools) {
    if (tool.outputSchema) outputValidators.set(tool.name, compileOutputValidator(tool.outputSchema));
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
