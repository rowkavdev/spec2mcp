/**
 * Spec loading: file path or URL, JSON or YAML, Swagger 2.0 conversion,
 * external $ref bundling, and operationId repair so every operation
 * reaches the Forge pipeline.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { convert as convertSwagger2 } from 'swagger2openapi';
import type { OpenAPIV3 } from 'openapi-types';
import { basename } from 'node:path';
import type { ApiOverlay, ApiOverlayFile } from '../vendor/forge/index.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export async function loadSpec(input: string): Promise<OpenAPIV3.Document> {
  let text: string;
  if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Failed to fetch spec: HTTP ${res.status} from ${input}`);
    text = await res.text();
  } else {
    text = await readFile(input, 'utf8');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = parseYaml(text);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Input is not an OpenAPI or Swagger document (expected a JSON or YAML object).');
  }

  let convertedFromSwagger2 = false;
  if (!('openapi' in raw)) {
    if ((raw as Record<string, unknown>).swagger === '2.0') {
      // Swagger 2.0: convert in memory, then run the same pipeline. Servers
      // come from host/basePath/schemes and securityDefinitions become
      // components.securitySchemes, so auth and base URL handling are
      // unchanged.
      const { openapi } = await convertSwagger2(raw as never, { patch: true, warnOnly: true } as never);
      raw = openapi;
      convertedFromSwagger2 = true;
    } else {
      throw new Error('Input does not look like an OpenAPI 3.x or Swagger 2.0 document (missing top-level "openapi"/"swagger").');
    }
  }

  // Bundle external $refs (files/URLs) into one document. Internal refs are
  // left as refs - Forge's resolver handles those. Bundle from the original
  // path/URL (not the parsed object) so relative external refs like
  // "../policies.yaml" resolve against the spec's own location. For URLs this
  // fetches the document a second time - acceptable for a generator. A
  // converted Swagger 2.0 document only exists in memory, so it bundles from
  // the object instead; refs relative to the spec's own location are
  // unsupported for 2.0 inputs (none of the major 2.0 publishers - Slack,
  // Kubernetes - use them).
  const doc = (await $RefParser.bundle((convertedFromSwagger2 ? raw : input) as never, {
    dereference: { circular: 'ignore' },
  })) as unknown as OpenAPIV3.Document;

  // Forge's operation indexer requires paths and components.schemas to exist;
  // real-world specs often omit components, and a webhook-only 3.1 spec may
  // omit paths entirely.
  const anyDoc = doc as unknown as Record<string, unknown>;
  if (typeof anyDoc.paths !== 'object' || anyDoc.paths === null) anyDoc.paths = {};
  if (typeof anyDoc.components !== 'object' || anyDoc.components === null) anyDoc.components = {};
  const components = anyDoc.components as Record<string, unknown>;
  if (typeof components.schemas !== 'object' || components.schemas === null) components.schemas = {};

  // OpenAPI 3.1 upgrades schemas to JSON Schema 2020-12, where `type` may be
  // a union array. Forge reads `type` as a single string, so collapse unions
  // before the document reaches the resolver.
  if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3.1')) {
    collapseTypeArrays(doc);
  }

  ensureOperationIds(doc);
  return doc;
}

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

function isJsonSchemaTypeArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((t) => typeof t === 'string' && JSON_SCHEMA_TYPES.has(t));
}

/**
 * Collapse JSON Schema 2020-12 type unions so Forge can type the schema:
 * `["string", "null"]` becomes `type: "string"` (a nullable parameter simply
 * is not required), and a union of several non-null types becomes an `anyOf`
 * of single-type branches, which the resolver already understands.
 * `example`/`examples` subtrees hold payload data, not schemas - a property
 * named "type" there is user data and is left alone.
 */
function collapseTypeArrays(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) collapseTypeArrays(item);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const rec = node as Record<string, unknown>;
  if (isJsonSchemaTypeArray(rec.type)) {
    const nonNull = rec.type.filter((t) => t !== 'null');
    if (nonNull.length === 1) {
      rec.type = nonNull[0];
    } else if (nonNull.length > 1) {
      rec.anyOf = nonNull.map((t) => ({ type: t }));
      delete rec.type;
    }
  }
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'example' || key === 'examples') continue;
    collapseTypeArrays(value);
  }
}

/**
 * Load OpenAPI Overlay documents (Overlay Specification v1.0.0), JSON or YAML.
 * Overlays rename, describe or remove operations before generation;
 * src/overlay.ts applies them and fails loudly on unmatched targets.
 */
export async function loadOverlays(paths: string[]): Promise<ApiOverlayFile[]> {
  const files: ApiOverlayFile[] = [];
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = parseYaml(text);
    }
    const overlay = parsed as ApiOverlay;
    if (!overlay || typeof overlay !== 'object' || typeof overlay.overlay !== 'string' || !Array.isArray(overlay.actions)) {
      throw new Error(`${path} is not an OpenAPI Overlay document (expected an "overlay" version and an "actions" array).`);
    }
    files.push({ name: basename(path), overlay });
  }
  return files;
}

/**
 * Forge indexes operations by operationId and silently skips operations that
 * have none. Many real-world specs omit them. Synthesise stable ids from
 * method + path so every operation becomes a tool, and uniquify collisions.
 */
export function ensureOperationIds(doc: OpenAPIV3.Document): void {
  const seen = new Set<string>();
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OpenAPIV3.OperationObject | undefined;
      if (!op || typeof op !== 'object') continue;
      let id = typeof op.operationId === 'string' && op.operationId.length > 0 ? op.operationId : synthesizeId(method, path);
      if (seen.has(id)) {
        let i = 2;
        while (seen.has(`${id}_${i}`)) i++;
        id = `${id}_${i}`;
      }
      seen.add(id);
      op.operationId = id;
    }
  }
}

function synthesizeId(method: string, path: string): string {
  const slug = path
    .replace(/[{}]/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
  return slug.length > 0 ? `${method}_${slug}` : `${method}_root`;
}
