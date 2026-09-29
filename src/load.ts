/**
 * Spec loading: file path or URL, JSON or YAML, external $ref bundling,
 * and operationId repair so every operation reaches the Forge pipeline.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import type { OpenAPIV3 } from 'openapi-types';

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
  if (typeof raw !== 'object' || raw === null || !('openapi' in raw)) {
    throw new Error('Input does not look like an OpenAPI 3.x document (missing top-level "openapi").');
  }

  // Bundle external $refs (files/URLs) into one document. Internal refs are
  // left as refs - Forge's resolver handles those.
  const doc = (await $RefParser.bundle(raw as never, {
    dereference: { circular: 'ignore' },
  })) as unknown as OpenAPIV3.Document;

  // Forge's operation indexer requires components.schemas to exist; minimal
  // real-world specs often omit components entirely.
  const anyDoc = doc as unknown as Record<string, unknown>;
  if (typeof anyDoc.components !== 'object' || anyDoc.components === null) anyDoc.components = {};
  const components = anyDoc.components as Record<string, unknown>;
  if (typeof components.schemas !== 'object' || components.schemas === null) components.schemas = {};

  ensureOperationIds(doc);
  return doc;
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
