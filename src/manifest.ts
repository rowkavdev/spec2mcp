/**
 * Manifest builder: walks every operation Forge resolved from the spec and
 * produces the operations.json manifest the generated MCP server runs from.
 * The manifest is the whole product of generation - the runtime that
 * interprets it is identical for every spec.
 */
import type { OpenAPIV3 } from 'openapi-types';
import {
  getAllOperationIds,
  resolveOperation,
  resolveDocRef,
  type MultipartField,
  type OperationInfo,
  type ParameterInfo,
} from '../vendor/forge/index.js';
import { toToolName, dedupeNames, toEnvPrefix } from './naming.js';
import { buildAuthPlan, type AuthPlan } from './auth.js';
import { operationIncluded, operationTags, type OperationFilters } from './filter.js';

export type ToolArg = {
  /** Tool argument name (dotted for nested body fields, e.g. "origin.host"). */
  name: string;
  /**
   * The API's own parameter name, set when the tool-facing name had to be
   * disambiguated (e.g. a query param and a body field both named "uris").
   * Path/query/header params go on the wire under this name; omit when
   * identical to `name`.
   */
  apiName?: string;
  location: 'path' | 'query' | 'header' | 'cookie' | 'body';
  /** For body args: path of API field names for nested body reconstruction. */
  apiFieldPath?: string[];
  /** True for multipart/form-data fields carrying file content (format: binary). */
  binary?: boolean;
  /** Default file-part MIME type from multipart encoding.contentType. */
  defaultMimeType?: string;
  /** OpenAPI parameter serialization (path/query/header). */
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  required: boolean;
  schema: Record<string, unknown>;
};

export type ToolDef = {
  name: string;
  description: string;
  operationId: string;
  tags: string[];
  method: string;
  path: string;
  /** Preferred request content type, when the operation has a body. */
  contentType?: string;
  /** True when the request body is a top-level array - exposed as one "body" arg. */
  requestBodyIsArray?: boolean;
  /** A required JSON/multipart object body may validly be empty. */
  requiredEmptyObject?: boolean;
  /** OpenAPI encoding rules keyed by form property name. */
  formEncoding?: Record<string, { style?: string; explode?: boolean; unsupported?: string }>;
  /**
   * MCP outputSchema for the tool, emitted when the spec declares a known
   * JSON schema for a 2xx response. Always an object schema per the MCP
   * spec; absent for freeform/unknown responses (those stay text-only).
   */
  outputSchema?: Record<string, unknown>;
  /**
   * True when the API's success body is not a JSON object (array or
   * primitive) and the runtime wraps it as { result: ... } in
   * structuredContent to satisfy MCP's object requirement.
   */
  outputWrap?: boolean;
  /** Declared success (2xx/default) response content types, used for the Accept header. */
  responseContentTypes?: string[];
  args: ToolArg[];
  inputSchema: Record<string, unknown>;
  /** Names of schemes used by this operation; [] explicitly sends no auth. */
  authSchemeNames: string[];
  /** Fully mapped OR alternatives in spec order (#146); present only when
   * more than one route exists. The runtime picks the first fully
   * configured alternative; authSchemeNames stays the first for older
   * runtimes. */
  authAlternatives?: string[][];
};

export type WebhookInfo = {
  /** Webhook name: the key in the spec's top-level webhooks object. */
  name: string;
  method: string;
  operationId?: string;
  description: string;
};

export type Manifest = {
  generator: string;
  apiTitle: string;
  apiVersion: string;
  /** The spec's declared OpenAPI version, e.g. "3.0.3" or "3.1.0". */
  specVersion: string;
  serverName: string;
  baseUrl: string;
  auth: AuthPlan;
  /**
   * Webhooks declared by an OpenAPI 3.1 spec. A webhook is an event the API
   * sends to the consumer, so it can never be an MCP tool - it is recorded
   * here for the generated README instead of being silently dropped.
   */
  webhooks: WebhookInfo[];
  /** Custom JSON Schema dialect from the spec's jsonSchemaDialect field, if declared. */
  jsonSchemaDialect?: string;
  /** Generation warnings beyond auth (auth carries its own): unresolved
   * response $refs and similar contract losses the user must see. */
  warnings?: string[];
  tools: ToolDef[];
};

/** The dialect a 3.1 spec uses when it does not declare jsonSchemaDialect. */
export const DEFAULT_31_DIALECT = 'https://spec.openapis.org/oas/3.1/dialect/base';

const WEBHOOK_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function extractWebhooks(doc: OpenAPIV3.Document): WebhookInfo[] {
  const out: WebhookInfo[] = [];
  const webhooks = (doc as unknown as Record<string, unknown>).webhooks;
  if (typeof webhooks !== 'object' || webhooks === null) return out;
  for (const [name, rawPathItem] of Object.entries(webhooks as Record<string, unknown>)) {
    // A webhook entry may be a $ref to components/pathItems (#132); resolve
    // it before walking methods or the webhook is silently dropped.
    const pathItem = resolveDocRef(rawPathItem);
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of WEBHOOK_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OpenAPIV3.OperationObject | undefined;
      if (!op || typeof op !== 'object') continue;
      const description = op.summary?.trim() || op.description?.split('\n')[0]?.trim() || '';
      const info: WebhookInfo = { name, method: method.toUpperCase(), description };
      if (typeof op.operationId === 'string' && op.operationId.length > 0) info.operationId = op.operationId;
      out.push(info);
    }
  }
  return out;
}

export type ManifestOptions = OperationFilters & {
  serverName?: string;
  baseUrl?: string;
  envPrefix?: string;
};

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

/** Recover representable primitive unions (including null) and array item
 * compositions from the loaded parameter schema when Forge narrows them. */
function primitiveComposition(schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  const key = Array.isArray(schema.oneOf) ? 'oneOf' : Array.isArray(schema.anyOf) ? 'anyOf' : undefined;
  if (!key) return undefined;
  const branches = schema[key] as unknown[];
  if (branches.length === 0) return undefined;
  const mapped = branches.map((branch) => {
    const node = resolveDocRef(branch) as Record<string, unknown> | undefined;
    if (!node || typeof node.type !== 'string' || !['string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) return undefined;
    const { $ref: _ref, nullable: _nullable, xml: _xml, ...constraints } = node;
    return constraints;
  });
  if (mapped.some((branch) => branch === undefined)) return undefined;
  return { [key]: mapped };
}

function parameterArgSchema(doc: OpenAPIV3.Document, op: OperationInfo, p: ParameterInfo, location: 'path' | 'query' | 'header'): Record<string, unknown> {
  const operation = doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods];
  const parameters = [...(doc.paths[op.path]?.parameters ?? []), ...(operation?.parameters ?? [])];
  const candidate = [...parameters].reverse().map((raw) => resolveDocRef(raw) as OpenAPIV3.ParameterObject)
    .find((param) => param?.in === location && param.name === p.name);
  const source = candidate?.schema as Record<string, unknown> | undefined;
  const resolved = resolveDocRef(source) as Record<string, unknown> | undefined;
  const composition = primitiveComposition(resolved);
  if (composition && new Set(((Object.values(composition)[0] as Record<string, unknown>[]).map((branch) => branch.type))).size > 1) return { ...composition, ...(p.description ? { description: p.description } : {}) };
  if (resolved?.type === 'array') {
    const items = resolveDocRef(resolved.items) as Record<string, unknown> | undefined;
    const itemComposition = primitiveComposition(items);
    if (itemComposition) return { type: 'array', items: itemComposition, ...(p.description ? { description: p.description } : {}) };
  }
  return restoreIntegerType(argSchema(p), resolved);
}

/**
 * Forge collapses integer to number in its parameter metadata, which makes
 * the generated input schema admit fractional values the API rejects
 * (#137). Recover the declared integer type from the source schema for the
 * scalar and for array items; the resolver metadata stays as Forge's
 * consumers expect it.
 */
function restoreIntegerType(schema: Record<string, unknown>, source: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!source || typeof source !== 'object') return schema;
  if (source.type === 'integer' && schema.type === 'number') schema.type = 'integer';
  const items = schema.items as Record<string, unknown> | undefined;
  const sourceItems = resolveDocRef(source.items) as Record<string, unknown> | undefined;
  if (items && items.type === 'number' && sourceItems?.type === 'integer') items.type = 'integer';
  return schema;
}

/**
 * Forge's resolver stringifies enum members for its SDK-oriented metadata,
 * so a { type: 'integer', enum: [1, 2] } parameter arrives as
 * { type: 'number', enum: ['1', '2'] } - valid against nothing (#130). The
 * runtime stringifies scalars at the HTTP serialization boundary anyway
 * (server.mjs parameterParts), so restore the declared primitive type here.
 * String-typed enums are left alone, and a value that does not parse keeps
 * its original form rather than becoming NaN.
 */
function restoreEnumTypes(values: string[], type: string): unknown[] {
  if (type !== 'integer' && type !== 'number' && type !== 'boolean') return values;
  return values.map((v) => {
    if (type === 'boolean') return v === 'true' ? true : v === 'false' ? false : v;
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? n : v;
  });
}

/**
 * Forge's resolver collects path, query and header parameters only, so a
 * declared cookie parameter silently vanished from the generated tool
 * (#138). Extract cookie parameters from the source document and build
 * their schemas directly - the source enum keeps its primitive types, since
 * these values never passed through the resolver's stringification (#130).
 */
function cookieParameters(doc: OpenAPIV3.Document, op: OperationInfo): OpenAPIV3.ParameterObject[] {
  const operation = doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods];
  // An operation parameter REPLACES a path-item parameter with the same
  // name and location (OAS fixed fields); concatenating naively kept both,
  // so an overriding operation cookie produced a duplicate, still-required
  // inherited argument (review on #138).
  const byName = new Map<string, OpenAPIV3.ParameterObject>();
  for (const level of [doc.paths[op.path]?.parameters ?? [], operation?.parameters ?? []]) {
    for (const raw of level) {
      const param = resolveDocRef(raw) as OpenAPIV3.ParameterObject;
      if (param?.in === 'cookie' && typeof param.name === 'string') byName.set(param.name, param);
    }
  }
  return [...byName.values()];
}

function cookieArgSchema(param: OpenAPIV3.ParameterObject): Record<string, unknown> {
  const resolved = resolveDocRef(param.schema) as Record<string, unknown> | undefined;
  const schema: Record<string, unknown> = {};
  const type = typeof resolved?.type === 'string' && JSON_TYPES.has(resolved.type) ? resolved.type : 'string';
  schema.type = type;
  if (type === 'array') {
    const items = resolveDocRef(resolved?.items) as Record<string, unknown> | undefined;
    const itemType = typeof items?.type === 'string' && JSON_TYPES.has(items.type) && items.type !== 'array' ? items.type : 'string';
    const itemSchema: Record<string, unknown> = { type: itemType };
    if (Array.isArray(items?.enum)) itemSchema.enum = items.enum.filter((v) => ['string', 'number', 'boolean'].includes(typeof v));
    schema.items = itemSchema;
  }
  if (Array.isArray(resolved?.enum)) schema.enum = resolved.enum.filter((v) => ['string', 'number', 'boolean'].includes(typeof v));
  if (resolved?.default !== undefined) schema.default = resolved.default;
  const description = param.description ?? (typeof resolved?.description === 'string' ? resolved.description : undefined);
  if (description) schema.description = description;
  return resolved?.nullable === true ? { anyOf: [schema, { type: 'null' }] } : schema;
}

function argSchema(p: ParameterInfo): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  const type = JSON_TYPES.has(p.type) ? p.type : 'string';
  schema.type = type;
  if (type === 'array') {
    const itemType = p.itemType && JSON_TYPES.has(p.itemType) && p.itemType !== 'array' ? p.itemType : 'string';
    const items: Record<string, unknown> = { type: itemType };
    if (p.itemEnumValues && p.itemEnumValues.length > 0) items.enum = restoreEnumTypes(p.itemEnumValues, itemType);
    schema.items = items;
  }
  if (type === 'object') schema.additionalProperties = true;
  if (p.enumValues && p.enumValues.length > 0) schema.enum = restoreEnumTypes(p.enumValues, type);
  if (p.default !== undefined) schema.default = p.default;
  if (p.description) schema.description = p.description;
  return schema;
}

/**
 * Real specs reuse one name across locations (Kubernetes has a path template
 * {path} plus a query param "path"; Spotify has "uris" in query and body).
 * The input schema keys args by name, so a collision would silently drop one
 * argument. Keep the first occurrence bare and suffix later ones with their
 * location ("uris_body"), preserving the API's wire name in apiName.
 */
/**
 * Merge the `properties` a schema contributes, including across allOf
 * branches (Forge flattens allOf when it derives body params, so the
 * nullability walk must see the same merged view - #87).
 */

/** Assign spec-derived keys without triggering inherited setters: a field
 * named "__proto__" hits the prototype setter on plain assignment and
 * silently vanishes from the built object (#115). */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function mergedProperties(schema: Record<string, unknown> | undefined, seen = new Set<unknown>()): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return {};
  seen.add(schema);
  const out: Record<string, unknown> = {};
  const mergeFrom = (source: Record<string, unknown>): void => {
    // Object.assign would run the "__proto__" setter on spec keys (#115).
    for (const [key, value] of Object.entries(source)) setOwn(out, key, value);
  };
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      mergeFrom(mergedProperties(resolveDocRef(branch) as Record<string, unknown> | undefined, seen));
    }
  }
  const own = schema.properties as Record<string, unknown> | undefined;
  if (own && typeof own === 'object') mergeFrom(own);
  return out;
}

/**
 * Forge's adapted parameter view drops nullability (#81): a body property
 * typed `["string", "null"]` arrives as a plain string argument, and input
 * validation would reject a valid null. Recover the marker from the loaded
 * document by walking the requestBody schema along the argument's field
 * path, merging allOf branches like Forge's flattening does (#87). Shapes
 * the walk cannot resolve (e.g. oneOf-derived args) keep the adapted view.
 */
/** Resolve the requestBody schema node at a body field path, merging allOf
 * branches at every level like Forge's flattening does (#87). */
function bodySchemaAtPath(doc: OpenAPIV3.Document, op: OperationInfo, fieldPath: string[]): Record<string, unknown> | undefined {
  const requestBody = resolveDocRef(
    doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody,
  ) as OpenAPIV3.RequestBodyObject | undefined;
  const mediaType = pickContentType(Object.keys(requestBody?.content ?? {}));
  let schema = resolveDocRef(mediaType && isJsonMediaType(mediaType) ? requestBody?.content?.[mediaType]?.schema : undefined) as Record<string, unknown> | undefined;
  for (const segment of fieldPath) {
    if (!schema || typeof schema !== 'object') return undefined;
    schema = resolveDocRef(mergedProperties(schema)[segment]) as Record<string, unknown> | undefined;
  }
  return schema;
}

/** A required JSON property with no writable tool path must not disappear
 * behind a partially flattened body. Fall back to a validated whole body. */
function missingRequiredBodyField(doc: OpenAPIV3.Document, op: OperationInfo, mediaType: string): boolean {
  const body = resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined;
  const root = resolveDocRef(body?.content?.[mediaType]?.schema) as Record<string, unknown> | undefined;
  if (!root || typeof root !== 'object') return false;
  const paths = op.bodyParams.map((p) => p.apiFieldPath);
  const seen = new Set<unknown>();
  const walk = (node: Record<string, unknown>, prefix: string[]): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    const properties = mergedProperties(node);
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        const resolved = resolveDocRef(branch) as Record<string, unknown> | undefined;
        if (resolved && Array.isArray(resolved.required)) for (const name of resolved.required) required.add(name);
      }
    }
    for (const name of required) {
      if (typeof name !== 'string') continue;
      const path = [...prefix, name];
      const covered = paths.some((p) => path.every((part, i) => p[i] === part) || p.every((part, i) => path[i] === part));
      if (!covered) return true;
      const child = resolveDocRef(properties[name]) as Record<string, unknown> | undefined;
      if (child && typeof child === 'object' && walk(child, path)) return true;
    }
    return false;
  };
  return walk(root, []);
}

function bodyPropertyNullable(doc: OpenAPIV3.Document, op: OperationInfo, fieldPath: string[]): boolean {
  return bodySchemaAtPath(doc, op, fieldPath)?.nullable === true;
}

function disambiguateArgNames(args: ToolArg[]): void {
  const taken = new Set<string>();
  for (const a of args) {
    if (!taken.has(a.name)) {
      taken.add(a.name);
      continue;
    }
    const original = a.name;
    let candidate = `${original}_${a.location}`;
    let i = 2;
    while (taken.has(candidate)) candidate = `${original}_${a.location}_${i++}`;
    a.name = candidate;
    if (a.location !== 'body') a.apiName = original;
    taken.add(candidate);
  }
}

function pickContentType(contentTypes: string[]): string | undefined {
  if (contentTypes.includes('application/json')) return 'application/json';
  return contentTypes[0];
}


/**
 * Deeply resolve `$ref`s inside a response schema into a self-contained JSON
 * Schema, safe for MCP clients that have no access to the OpenAPI document.
 * `resolveDocRef` follows one level; we recurse through the schema tree.
 * Cyclic refs (common in component schemas) collapse to `{}` (any) instead
 * of recursing forever. OpenAPI-only annotations that mean nothing to a JSON
 * Schema validator are dropped; `nullable: true` becomes a type union.
 */
const MAX_SCHEMA_DEPTH = 12;
/** Schemas larger than this stay text-only: outputSchema travels inside
 * tools/list, and multi-MB listings break MCP stdio clients. */
const MAX_OUTPUT_SCHEMA_BYTES = 4096;

/**
 * Limit work while constructing a schema, not after allocating the entire
 * dereferenced tree. The extra room permits the root object type override
 * (which can shorten a nullable object type) before the exact final check.
 */
const DEREFERENCE_BYTE_BUDGET = MAX_OUTPUT_SCHEMA_BYTES + 64;

class SchemaTooLarge extends Error {}

type SchemaBudget = { remaining: number };

function charge(budget: SchemaBudget, bytes: number): void {
  budget.remaining -= bytes;
  if (budget.remaining < 0) throw new SchemaTooLarge();
}

/** Count JSON.stringify's UTF-16 length, including escaping, before copying. */
function jsonLength(value: unknown, budget: SchemaBudget): number {
  if (typeof value === 'string' && value.length + 2 > budget.remaining) throw new SchemaTooLarge();
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * OpenAPI `writeOnly` marks a request-only property: a valid response never
 * has to contain it, so it must not stay in a response schema's `required`
 * (#141). Strip it recursively after dereferencing; `readOnly` stays - a
 * response may and must carry those fields. The dereferenced output is a
 * fresh tree, so mutation is safe.
 */
const SCHEMA_SINGLE_KEYS = new Set(['items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties']);
const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']);

function stripWriteOnlyRequired(node: unknown): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const rec = node as Record<string, unknown>;
  const properties = rec.properties as Record<string, unknown> | undefined;
  const required = rec.required;
  if (Array.isArray(required) && properties && typeof properties === 'object') {
    const kept = required.filter((name) => {
      const prop = properties[name as string] as Record<string, unknown> | undefined;
      return !prop || typeof prop !== 'object' || prop.writeOnly !== true;
    });
    if (kept.length === 0) delete rec.required;
    else rec.required = kept;
  }
  // Recurse only into schema-bearing keywords. Walking every value reached
  // into const/enum/default/examples literal data and rewrote it (review on
  // #141).
  for (const key of SCHEMA_SINGLE_KEYS) stripWriteOnlyRequired(rec[key]);
  for (const key of SCHEMA_ARRAY_KEYS) {
    const value = rec[key];
    if (Array.isArray(value)) for (const sub of value) stripWriteOnlyRequired(sub);
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const value = rec[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const sub of Object.values(value)) stripWriteOnlyRequired(sub);
    }
  }
}

function dereferenceSchema(node: unknown, refChain: Set<string>, budget: SchemaBudget, depth = 0, onUnresolved?: (ref: string) => void, refSiblings = false): unknown {
  if (Array.isArray(node)) {
    charge(budget, 2); // brackets
    if (depth > MAX_SCHEMA_DEPTH) return [];
    const out: unknown[] = [];
    for (const value of node) {
      if (out.length) charge(budget, 1); // comma
      out.push(dereferenceSchema(value, refChain, budget, depth + 1, onUnresolved, refSiblings));
    }
    return out;
  }
  if (!node || typeof node !== 'object') {
    charge(budget, jsonLength(node, budget));
    return node;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    charge(budget, 2);
    return {};
  }

  let target = node as Record<string, unknown>;
  const ref = typeof target.$ref === 'string' ? target.$ref : undefined;
  let chain = refChain;
  if (ref) {
    if (refChain.has(ref)) {
      charge(budget, 2);
      return {};
    }
    const resolved = resolveDocRef(target) as Record<string, unknown>;
    if (resolved === target) {
      // The walk failed: the pointer does not resolve (#112). Never
      // advertise the empty collapse as a schema - the caller treats the
      // shape as unknown and surfaces the ref instead.
      onUnresolved?.(ref);
      charge(budget, 2);
      return {};
    }
    chain = new Set(refChain);
    chain.add(ref);
    if (refSiblings) {
      const siblings = Object.fromEntries(Object.entries(target).filter(([key]) => key !== '$ref'));
      if (Object.keys(siblings).length > 0) {
        // JSON Schema 2020-12 applies $ref siblings as constraints, not overrides.
        // Keep the intersection explicit: overlapping properties, enum, limits,
        // and required arrays must all hold, not last-write-wins.
        target = { allOf: [resolved, siblings] };
      } else target = resolved;
    } else target = resolved;
  }

  charge(budget, 2); // braces
  const out: Record<string, unknown> = {};
  let first = true;
  // Do not materialize Object.entries(target): components may have thousands
  // of properties, most of which we will never need to visit.
  for (const key in target) {
    if (!Object.hasOwn(target, key) || key === '$ref' || key === 'xml' || key === 'discriminator' || key === 'externalDocs' || key === 'nullable') continue;
    charge(budget, (first ? 0 : 1) + jsonLength(key, budget) + 1);
    first = false;
    setOwn(out, key, dereferenceSchema(target[key], chain, budget, depth + 1, onUnresolved, refSiblings) as unknown);
  }
  if (target.nullable === true && typeof out.type === 'string') {
    // Replace the already-counted scalar type with its union representation.
    const nullableType = [out.type, 'null'];
    charge(budget, JSON.stringify(nullableType).length - JSON.stringify(out.type).length);
    out.type = nullableType;
  } else if (target.nullable === true && Array.isArray(out.anyOf)) {
    // A collapsed multi-type union carries nullability on the anyOf shell
    // (#81); append the null branch rather than dropping it.
    const nullBranch = { type: 'null' };
    charge(budget, 1 + jsonLength(nullBranch, budget));
    out.anyOf = [...out.anyOf, nullBranch];
  }
  return out;
}

/** Prefer specific 2xx codes, then the 2XX range, then default. */
function successJsonSchema(op: OperationInfo, doc: OpenAPIV3.Document, onUnresolved?: (ref: string) => void): Record<string, unknown> | undefined {
  const codes = Object.keys(op.responses ?? {})
    .filter((c) => /^2\d\d$/.test(c) || /^2XX$/i.test(c) || c === 'default')
    .sort((a, b) => {
      const rank = (code: string) => /^2\d\d$/.test(code) ? 0 : /^2XX$/i.test(code) ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  // MCP advertises one outputSchema per tool, so a schema is only honest
  // when every success status that can return JSON agrees on the shape.
  // A valid 201 must never fail client-side validation against a 200-only
  // schema. Statuses without a JSON schema produce no structured content
  // and cannot violate; a status whose schema is over budget has an unknown
  // shape, which cannot be proven equal - advertise nothing rather than
  // risk rejecting a valid success for a status we did not validate.
  const shapes: Record<string, unknown>[] = [];
  let unresolvedRef = false;
  const trackUnresolved = (ref: string): void => {
    unresolvedRef = true;
    onUnresolved?.(ref);
  };
  for (const code of codes) {
    const content = op.responses[code]?.content ?? {};
    // Every declared successful representation must be able to satisfy the
    // advertised schema (#72), across statuses and media alternatives:
    // - a bodyless success (204 No Content) returns no structured content;
    // - a status committed to non-JSON media (or wildcard `* /*`, which
    //   declares no commitment - #65) can validly answer non-JSON;
    // - a JSON media alternative without a schema admits any shape;
    // - a non-JSON media alternative alongside JSON can be the actual
    //   response while the schema describes only the JSON one;
    // - JSON media alternatives under one status (application/json,
    //   application/problem+json, vendor +json types) can each be the
    //   actual response, so every one of them must agree (#76).
    // In each case advertising would reject a valid success, so the tool
    // stays text-only.
    const mediaTypes = Object.keys(content);
    if (mediaTypes.length === 0) return undefined;
    const jsonMedia = mediaTypes.filter(isJsonMediaType);
    if (jsonMedia.length === 0) return undefined;
    if (jsonMedia.length !== mediaTypes.length) return undefined;
    for (const mediaType of jsonMedia) {
      // Forge resolves top-level response $refs before exposing OperationInfo,
      // which discards 3.1 sibling constraints. Read that schema from the
      // loaded document only when it actually has siblings to preserve.
      let schema = content[mediaType]?.schema as Record<string, unknown> | undefined;
      if (doc.openapi.startsWith('3.1.')) {
        const sourceResponses = doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.responses;
        const rawResponse = resolveDocRef(sourceResponses?.[code]) as OpenAPIV3.ResponseObject | undefined;
        const loaded = rawResponse?.content?.[mediaType]?.schema as Record<string, unknown> | undefined;
        if (loaded && '$ref' in loaded && Object.keys(loaded).length > 1) schema = loaded;
      }
      if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) return undefined;
      let dereferenced: Record<string, unknown>;
      try {
        dereferenced = dereferenceSchema(schema, new Set(), { remaining: DEREFERENCE_BYTE_BUDGET }, 0, trackUnresolved, doc.openapi.startsWith('3.1.')) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof SchemaTooLarge) return undefined;
        throw error;
      }
      // An unresolved $ref collapses to an open schema (#112); advertising
      // it would accept everything, so the tool stays text-only and the
      // ref is surfaced through onUnresolved.
      if (unresolvedRef) return undefined;
      shapes.push(dereferenced);
    }
  }
  if (shapes.length === 0) return undefined;
  const first = JSON.stringify(shapes[0]);
  for (const shape of shapes.slice(1)) {
    if (JSON.stringify(shape) !== first) return undefined;
  }
  return shapes[0];
}

function isNonObjectValue(value: unknown): boolean {
  return value === null || Array.isArray(value) || typeof value !== 'object';
}

/**
 * MCP structured content must be an object, so a schema that also admits a
 * non-object root - null, array or scalar, via type unions, anyOf, oneOf,
 * enum, const, not, or an unconstrained schema - takes the result wrap
 * (#92, #95, #102). Walk the structure instead of sampling values (#107):
 * finite probes miss constrained variants like oneOf [object, array with
 * minItems]. Explicitly non-object schemas are already wrapped via
 * schemaIsObject; this decides object-capable shapes. Typeless object
 * keywords (properties, required) keep the OpenAPI object intent; a
 * typeless "not" or fully unconstrained schema admits non-object roots.
 */
function schemaAdmitsNonObjectRoot(schema: Record<string, unknown>, seen = new Set<unknown>()): boolean {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return false;
  seen.add(schema);
  if (Array.isArray(schema.enum)) return schema.enum.some(isNonObjectValue);
  if ('const' in schema) return isNonObjectValue(schema.const);
  const t = schema.type;
  if (typeof t === 'string') return t !== 'object';
  if (Array.isArray(t)) return t.some((branch) => branch !== 'object');
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.some((branch) => schemaAdmitsNonObjectRoot(branch as Record<string, unknown>, seen));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.some((branch) => schemaAdmitsNonObjectRoot(branch as Record<string, unknown>, seen));
  }
  // allOf is an intersection: a non-object root must satisfy every branch.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.every((branch) => schemaAdmitsNonObjectRoot(branch as Record<string, unknown>, seen));
  }
  if ('not' in schema) return true;
  // Typeless object keywords keep the OpenAPI object intent (#111, a
  // deliberate recorded decision): strict JSON Schema 2020-12 admits
  // scalar roots against `{properties: ...}` (properties only constrains
  // objects), and 3.1 specs are 2020-12 - but the 3.0 idiom and every
  // real-world spec mean an object here. Rewrapping the idiom would churn
  // contracts for no real API; docs/guide.md records the caveat.
  if ('properties' in schema || 'required' in schema) return false;
  return true;
}

/**
 * The exact JSON media predicate (#116): application/json or a +json
 * suffix. runtime/server.mjs isJsonType carries the same one rule - keep
 * them in sync. A substring match admitted types like application/json-seq
 * or text/json, whose bodies are not single JSON documents: the compiler
 * advertised an outputSchema the runtime could never produce structured
 * content for, and every valid response came back isError.
 */
function isJsonMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return normalized === 'application/json' || normalized.endsWith('+json');
}

function schemaIsObject(schema: Record<string, unknown>): boolean {
  const t = schema.type;
  if (typeof t === 'string') return t === 'object';
  if (Array.isArray(t)) return t.includes('object');
  // No explicit type: object-shaped keywords (properties, allOf, ...) imply object.
  return true;
}

/**
 * One multipart/form-data field becomes one tool argument. Binary (file)
 * fields take an object with the base64-encoded content plus an optional
 * filename and MIME type; the runtime turns it into a FormData file part.
 * Scalar fields are appended as form fields, object/array fields as JSON.
 */
function multipartFieldArg(field: MultipartField): ToolArg {
  if (field.isBinary) {
    return {
      name: field.name,
      apiName: field.name,
      location: 'body',
      apiFieldPath: [],
      binary: true,
      required: field.required,
      schema: {
        type: 'object',
        description: `${field.description} File upload.`,
        properties: {
          contentBase64: { type: 'string', description: 'Base64-encoded file content.' },
          filename: { type: 'string', description: `File name sent to the API (default: "${field.name}").` },
          mimeType: { type: 'string', description: 'File MIME type (default: application/octet-stream).' },
        },
        required: ['contentBase64'],
        additionalProperties: false,
      },
    };
  }
  const schema: Record<string, unknown> = { description: field.description };
  if (field.type === 'object') {
    schema.type = 'object';
    schema.additionalProperties = true;
  } else if (field.type === 'array') {
    schema.type = 'array';
    schema.items = {};
  } else {
    schema.type = field.type;
  }
  return { name: field.name, apiName: field.name, location: 'body', apiFieldPath: [], required: field.required, schema };
}

/** True only when an empty object provably satisfies an object schema: no
 * required properties, no positive minProperties, no composition keywords
 * (anyOf/oneOf/not/if) whose verdict on {} needs full validation, and no
 * enum/const that excludes {}, anywhere in the allOf closure.
 * Presence-triggered keywords (dependencies, propertyNames,
 * additionalProperties) cannot fail on {} and are ignored. Unresolvable or
 * cyclic references fail closed. */
function emptyObjectSatisfies(schema: Record<string, unknown> | undefined, seen: Set<unknown> = new Set()): boolean {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return false;
  seen.add(schema);
  if (Array.isArray(schema.required) && schema.required.length > 0) return false;
  if (typeof schema.minProperties === 'number' && schema.minProperties > 0) return false;
  // enum/const constrain the instance regardless of properties: {} must be a
  // member, which for JSON Schema equality means exactly the empty object.
  const isEmptyPlainObject = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
  if (schema.const !== undefined && !isEmptyPlainObject(schema.const)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.some(isEmptyPlainObject))) return false;
  if (schema.anyOf !== undefined || schema.oneOf !== undefined || schema.not !== undefined || schema.if !== undefined) return false;
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (!emptyObjectSatisfies(resolveDocRef(branch) as Record<string, unknown> | undefined, seen)) return false;
    }
  }
  return true;
}

/** Content types declared on success (2xx or default) responses, in spec order. */
function collectResponseContentTypes(op: OperationInfo): string[] {
  const seen = new Set<string>();
  for (const [status, info] of Object.entries(op.responses)) {
    if (!status.startsWith('2') && status !== 'default') continue;
    for (const contentType of Object.keys(info.content)) seen.add(contentType);
  }
  return [...seen];
}

export function buildManifest(doc: OpenAPIV3.Document, opts: ManifestOptions = {}): Manifest {
  const info = doc.info ?? ({ title: 'API', version: '0.0.0' } as OpenAPIV3.Document['info']);
  const apiTitle = info.title ?? 'API';
  const envPrefix = opts.envPrefix ?? toEnvPrefix(opts.serverName ?? apiTitle);
  const { auth, forOperation } = buildAuthPlan(doc, envPrefix);

  const firstServer = doc.servers?.[0]?.url ?? '';
  const baseUrl = opts.baseUrl ?? firstServer;

  const operationIds = getAllOperationIds();
  const warnings: string[] = [];
  const tagsById = operationTags(doc);
  const selectedIds = operationIds.filter((id) => operationIncluded(id, tagsById.get(id) ?? [], opts));
  const toolNames = dedupeNames(selectedIds.map(toToolName));
  const tools: ToolDef[] = [];

  selectedIds.forEach((operationId, i) => {
    const op = resolveOperation(operationId);
    const toolName = toolNames[i];
    if (!op || !toolName) return;

    const args: ToolArg[] = [];
    const nullableParents: { arg: ToolArg; node: Record<string, unknown> }[] = [];
    for (const p of op.pathParams) {
      args.push({ name: p.name, location: 'path', required: true, schema: parameterArgSchema(doc, op, p, 'path'), ...(p.style !== undefined ? { style: p.style } : {}), ...(p.explode !== undefined ? { explode: p.explode } : {}), ...(p.allowReserved !== undefined ? { allowReserved: p.allowReserved } : {}) });
    }
    for (const p of op.queryParams) {
      args.push({ name: p.name, location: 'query', required: p.required, schema: parameterArgSchema(doc, op, p, 'query'), ...(p.style !== undefined ? { style: p.style } : {}), ...(p.explode !== undefined ? { explode: p.explode } : {}), ...(p.allowReserved !== undefined ? { allowReserved: p.allowReserved } : {}) });
    }
    for (const p of op.headerParams) {
      args.push({ name: p.name, location: 'header', required: p.required, schema: parameterArgSchema(doc, op, p, 'header'), ...(p.style !== undefined ? { style: p.style } : {}), ...(p.explode !== undefined ? { explode: p.explode } : {}), ...(p.allowReserved !== undefined ? { allowReserved: p.allowReserved } : {}) });
    }
    for (const p of cookieParameters(doc, op)) {
      // Cookie parameters always serialize with form style; record it
      // explicitly so the runtime does not fall back to simple.
      args.push({ name: p.name, location: 'cookie', required: p.required === true, schema: cookieArgSchema(p), style: p.style ?? 'form', ...(p.explode !== undefined ? { explode: p.explode } : {}) });
    }

    const contentType = op.hasRequestBody ? pickContentType(op.requestContentTypes) : undefined;

    // Schema.required applies only when a body is present. The OpenAPI
    // requestBody.required flag controls whether any body is needed at all.
    const bodyRequired = (resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined)?.required === true;
    const rootRequired = new Set(op.requestBodyRequired);
    // A required object body where {} is invalid for reasons the flattened
    // arguments cannot express (minProperties, composition keywords) must not
    // invent an empty body: fall back to a required whole-body argument whose
    // dereferenced schema keeps the constraints. Root-level required
    // properties are left to the flattening path, which already requires them.
    const emptyBodyFallback = bodyRequired && contentType === 'application/json' && (() => {
      const body = resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined;
      const schema = resolveDocRef(body?.content?.['application/json']?.schema) as Record<string, unknown> | undefined;
      if (schema?.type !== 'object') return false;
      if (Array.isArray(schema.required) && schema.required.length > 0) return false;
      return !emptyObjectSatisfies(schema);
    })();
    const wholeBodyRequired = contentType !== undefined && isJsonMediaType(contentType) && (missingRequiredBodyField(doc, op, contentType) || emptyBodyFallback);
    let wholeBodySchema: Record<string, unknown> | undefined;
    if (wholeBodyRequired) {
      const node = resolveDocRef((resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject)?.content?.[contentType]?.schema);
      try {
        wholeBodySchema = dereferenceSchema(node, new Set(), { remaining: DEREFERENCE_BYTE_BUDGET }) as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof SchemaTooLarge)) throw error;
        warnings.push(`${toolName}: required body properties cannot be flattened and the whole-body schema exceeds the input budget; using an unconstrained body argument`);
        wholeBodySchema = {};
      }
    }
    if (contentType && isJsonMediaType(contentType) && contentType !== 'application/json') {
      const body = resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined;
      const schema = resolveDocRef(body?.content?.[contentType]?.schema) as Record<string, unknown> | undefined;
      const collect = (node: Record<string, unknown> | undefined): void => {
        if (!node) return;
        if (Array.isArray(node.required)) for (const name of node.required) if (typeof name === 'string') rootRequired.add(name);
        if (Array.isArray(node.allOf)) for (const branch of node.allOf) collect(resolveDocRef(branch) as Record<string, unknown>);
      };
      collect(schema);
    }
    if (wholeBodyRequired) {
      args.push({ name: 'body', location: 'body', apiFieldPath: [], required: bodyRequired, schema: wholeBodySchema! });
    } else if (op.requestBodyIsArray) {
      const requestBody = resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined;
      const raw = resolveDocRef(requestBody?.content?.[contentType ?? 'application/json']?.schema);
      let schema: Record<string, unknown>;
      try {
        schema = dereferenceSchema(raw, new Set(), { remaining: DEREFERENCE_BYTE_BUDGET }) as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof SchemaTooLarge)) throw error;
        warnings.push(`${toolName}: array body schema exceeds the input budget; using an unconstrained array argument`);
        schema = { type: 'array', items: {} };
      }
      args.push({
        name: 'body',
        location: 'body',
        apiFieldPath: [],
        required: bodyRequired,
        schema: { ...schema, description: schema.description ?? op.requestBodyDescription ?? 'Request body (JSON array).' },
      });
    } else if (op.bodyParams.length > 0) {
      for (const p of op.bodyParams) {
        const argName = p.apiFieldPath.join('.');
        // A leaf is required at tool level when it is required within its
        // parent and its root field is required at body level. Nested optional
        // parents make this an approximation - documented in the README.
        const required = bodyRequired && p.required && rootRequired.has(p.apiFieldPath[0] ?? '');
        // Nullable is not optional (#81): a required property may still be
        // null, so wrap the adapted view rather than loosening `required`.
        const leafSchema = restoreIntegerType(argSchema(p), bodySchemaAtPath(doc, op, p.apiFieldPath));
        const schema = bodyPropertyNullable(doc, op, p.apiFieldPath)
          ? { anyOf: [leafSchema, { type: 'null' }] }
          : leafSchema;
        args.push({ name: argName, location: 'body', apiFieldPath: p.apiFieldPath, required, schema });
      }
      // A nullable object parent flattens to leaves in Forge's view, so
      // null for the parent is unsendable and {"pet": null} silently goes
      // out as an empty body (#120). Retain a parent arg accepting
      // object|null alongside the leaf args. Parent args come after the
      // leaves, so on the wire a provided parent replaces its subtree; a
      // provided leaf with an absent parent still builds the object.
      // Nested parents stay optional: required-ness within an optional
      // parent is the same approximation the leaves document.
      const seenParents = new Set<string>();
      for (const p of op.bodyParams) {
        for (let depth = 1; depth < p.apiFieldPath.length; depth++) {
          const prefix = p.apiFieldPath.slice(0, depth);
          const key = prefix.join('.');
          if (seenParents.has(key)) continue;
          seenParents.add(key);
          const node = bodySchemaAtPath(doc, op, prefix);
          if (!node || node.nullable !== true) continue;
          if (node.type !== 'object' && !node.properties && !Array.isArray(node.allOf)) continue;
          // The object branch carries the full dereferenced shape (minus
          // the nullable marker), so "pet.id required when pet is an
          // object" is enforced inside the parent route too (#122). A
          // schema too large to inline falls back to the coarse object
          // branch, matching argSchema's coarseness elsewhere.
          let objectBranch: Record<string, unknown> = { type: 'object' };
          try {
            const dereferenced = dereferenceSchema(node, new Set(), { remaining: DEREFERENCE_BYTE_BUDGET }) as Record<string, unknown>;
            if (dereferenced && typeof dereferenced === 'object') objectBranch = dereferenced;
            // The null sibling covers nullability; the object branch must
            // admit objects only, or its required properties would also
            // demand them on a null value.
            if (Array.isArray(objectBranch.type)) {
              const nonNull = objectBranch.type.filter((t) => t !== 'null');
              objectBranch.type = nonNull.length === 1 ? nonNull[0] : nonNull;
            }
            delete objectBranch.nullable;
          } catch {
            // SchemaTooLarge: keep the coarse branch.
          }
          const arg: ToolArg = {
            name: key,
            location: 'body',
            apiFieldPath: prefix,
            required: depth === 1 ? bodyRequired && rootRequired.has(prefix[0] ?? '') : false,
            schema: {
              anyOf: [objectBranch, { type: 'null' }],
              ...(typeof node.description === 'string' ? { description: node.description } : {}),
            },
          };
          args.push(arg);
          nullableParents.push({ arg, node });
        }
      }
    } else if (contentType === 'multipart/form-data' && op.multipart) {
      const body = resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined;
      const encodings = body?.content?.['multipart/form-data']?.encoding;
      for (const field of op.multipart.fields) {
        const arg = multipartFieldArg(field);
        const declaredMime = encodings?.[field.name]?.contentType;
        if (arg.binary && typeof declaredMime === 'string' && declaredMime.trim()) {
          arg.defaultMimeType = declaredMime.trim();
          const mimeSchema = (arg.schema.properties as Record<string, Record<string, unknown>>).mimeType;
          mimeSchema!.description = `File MIME type (default: ${arg.defaultMimeType}).`;
        }
        arg.required = bodyRequired && arg.required;
        args.push(arg);
      }
    } else if (op.hasRequestBody) {
      // A primitive JSON root is a raw body, but its source constraints still
      // govern the tool argument. Non-JSON/free-form bodies retain the old view.
      let rawSchema: Record<string, unknown> | undefined;
      if (contentType && isJsonMediaType(contentType)) {
        const body = resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined;
        const node = body?.content?.[contentType]?.schema;
        if (node && typeof node === 'object') {
          let unresolved = false;
          try {
            const schema = dereferenceSchema(node, new Set(), { remaining: DEREFERENCE_BYTE_BUDGET }, 0,
              () => { unresolved = true; }, doc.openapi.startsWith('3.1.')) as Record<string, unknown>;
            if (!unresolved) rawSchema = schema;
            else warnings.push(`${toolName}: raw JSON body schema has an unresolved reference; using an unconstrained body argument`);
          } catch (error) {
            if (!(error instanceof SchemaTooLarge)) throw error;
            warnings.push(`${toolName}: raw JSON body schema exceeds the input budget; using an unconstrained body argument`);
          }
        }
      }
      args.push({
        name: 'body',
        location: 'body',
        apiFieldPath: [],
        required: bodyRequired,
        schema: rawSchema ? { ...rawSchema, description: rawSchema.description ?? op.requestBodyDescription ?? 'Raw request body.' }
          : contentType === 'application/x-www-form-urlencoded'
          ? { type: 'object', description: op.requestBodyDescription ?? 'Form fields; array serialization follows the spec encoding.' }
          : contentType && (contentType === 'application/xml' || contentType === 'text/xml' || contentType.endsWith('+xml'))
            ? { type: 'string', description: op.requestBodyDescription ?? 'Pre-serialized XML request body.' }
            : { description: op.requestBodyDescription ?? 'Raw request body.' },
      });
    }

    disambiguateArgNames(args);

    const properties: Record<string, unknown> = {};
    const requiredArgs: string[] = [];
    for (const a of args) {
      setOwn(properties, a.name, a.schema);
      if (a.required) requiredArgs.push(a.name);
    }
    // A required nullable parent with required leaves cannot sit in
    // `required` flatly: requiring both pet and pet.id makes the null
    // branch inaccessible (#122). The runtime's coverage rule accepts
    // either route (parent arg or leaf args), so the input schema says the
    // same with conditional clauses: presence is the parent OR any
    // descendant, and each required descendant is itself OR an ancestor.
    // This applies at every depth (#133): a nested nullable parent is
    // scoped to its own field path, and because required-ness chains down
    // through required arrays, a required descendant proves the parent's
    // presence is required too.
    const conditional: Record<string, unknown>[] = [];
    const bodyArgs = args.filter((a) => a.location === 'body' && a.apiFieldPath && a.apiFieldPath.length > 0);
    for (const { arg: parent } of nullableParents) {
      const parentPath = parent.apiFieldPath!;
      const subtree = bodyArgs.filter((a) =>
        a !== parent &&
        a.apiFieldPath!.length > parentPath.length &&
        parentPath.every((seg, i) => a.apiFieldPath![i] === seg));
      if (subtree.length === 0) continue;
      if (!parent.required && !subtree.some((a) => a.required)) continue;
      const drop = new Set([parent.name, ...subtree.filter((a) => a.required).map((a) => a.name)]);
      for (let i = requiredArgs.length - 1; i >= 0; i--) {
        if (drop.has(requiredArgs[i]!)) requiredArgs.splice(i, 1);
      }
      conditional.push({ anyOf: [parent, ...subtree].map((a) => ({ required: [a.name] })) });
      for (const leaf of subtree) {
        if (!leaf.required) continue;
        const ancestors = [parent, ...subtree.filter((a) => a !== leaf && leaf.apiFieldPath!.length > a.apiFieldPath!.length && a.apiFieldPath!.every((seg, i) => leaf.apiFieldPath![i] === seg))];
        conditional.push({ anyOf: [leaf, ...ancestors].map((a) => ({ required: [a.name] })) });
      }
    }

    const authSelection = forOperation(
      doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods] as OpenAPIV3.OperationObject ?? {},
      `${op.method.toUpperCase()} ${op.path}`,
    );

    const description =
      op.description.split('\n')[0]?.trim() || `${op.method.toUpperCase()} ${op.path}`;

    const tool: ToolDef = {
      name: toolName,
      description,
      operationId,
      tags: tagsById.get(operationId) ?? [],
      method: op.method.toUpperCase(),
      path: op.path,
      args,
      authSchemeNames: authSelection.names,
      // Emitted only with more than one OR alternative (#146); single-route
      // tools keep the legacy shape and older runtimes read authSchemeNames.
      ...(authSelection.alternatives.length > 1 ? { authAlternatives: authSelection.alternatives } : {}),
      inputSchema: {
        type: 'object',
        properties,
        required: requiredArgs,
        additionalProperties: false,
        ...(conditional.length > 0 ? { allOf: conditional } : {}),
      },
    };
    if (contentType) tool.contentType = contentType;
    if (op.requestBodyIsArray) tool.requestBodyIsArray = true;
    if (bodyRequired && (contentType === 'application/json' || contentType === 'multipart/form-data') &&
      !args.some((arg) => arg.location === 'body' && arg.required)) {
      const requestBody = resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined;
      const schema = resolveDocRef(requestBody?.content?.[contentType]?.schema) as Record<string, unknown> | undefined;
      if (schema?.type === 'object' && emptyObjectSatisfies(schema)) tool.requiredEmptyObject = true;
    }
    if (contentType === 'application/x-www-form-urlencoded') {
      const requestBody = resolveDocRef(doc.paths[op.path]?.[op.method as OpenAPIV3.HttpMethods]?.requestBody) as OpenAPIV3.RequestBodyObject | undefined;
      const encodings = requestBody?.content?.[contentType]?.encoding;
      if (encodings && Object.keys(encodings).length > 0) {
        tool.formEncoding = Object.fromEntries(Object.entries(encodings).map(([name, encoding]) => [name, {
          ...(encoding.style !== undefined ? { style: encoding.style } : {}),
          ...(encoding.explode !== undefined ? { explode: encoding.explode } : {}),
          ...(encoding.contentType !== undefined || encoding.allowReserved !== undefined
            ? { unsupported: 'contentType or allowReserved' } : {}),
        }]));
      }
    }


    const responseSchema = successJsonSchema(op, doc, (ref) => {
      warnings.push(`${toolName}: response schema $ref "${ref}" could not be resolved; the tool stays text-only (#112)`);
    });
    if (responseSchema) {
      stripWriteOnlyRequired(responseSchema);
      // The advertised top-level type must be the literal "object" (MCP
      // clients validate it). MCP requires object-shaped structured
      // content, so arrays, primitives and root-nullable schemas (#92: a
      // valid JSON null cannot be emitted unwrapped) go under a single
      // "result" property; plain object schemas advertise as-is.
      const wrap = !schemaIsObject(responseSchema) || schemaAdmitsNonObjectRoot(responseSchema);
      const candidate = wrap
        ? { type: 'object', properties: { result: responseSchema }, required: ['result'] }
        : { ...responseSchema, type: 'object' };
      if (JSON.stringify(candidate).length <= MAX_OUTPUT_SCHEMA_BYTES) {
        tool.outputSchema = candidate;
        if (wrap) tool.outputWrap = true;
      }
      // Over-budget schemas (huge generated component trees) stay text-only.
    }
    const responseContentTypes = collectResponseContentTypes(op);
    if (responseContentTypes.length > 0) tool.responseContentTypes = responseContentTypes;
    tools.push(tool);
  });

  const manifest: Manifest = {
    generator: `spec2mcp`,
    ...(warnings.length > 0 ? { warnings } : {}),
    apiTitle,
    apiVersion: info.version ?? '0.0.0',
    specVersion: doc.openapi ?? '',
    serverName: opts.serverName ?? envPrefix.toLowerCase().replace(/_/g, '-'),
    baseUrl,
    auth,
    webhooks: extractWebhooks(doc),
    tools,
  };
  const dialect = (doc as unknown as Record<string, unknown>).jsonSchemaDialect;
  if (typeof dialect === 'string' && dialect.length > 0) manifest.jsonSchemaDialect = dialect;
  return manifest;
}
