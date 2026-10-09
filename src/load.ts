/**
 * Spec loading: file path or URL, JSON or YAML, Swagger 2.0 conversion,
 * external $ref bundling, and operationId repair so every operation
 * reaches the Forge pipeline.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import $RefParser, { getJsonSchemaRefParserDefaultOptions, type FileInfo, type Plugin } from '@apidevtools/json-schema-ref-parser';
import { convert as convertSwagger2 } from 'swagger2openapi';
import type { OpenAPIV3 } from 'openapi-types';
import { basename, dirname, resolve as resolvePath } from 'node:path';
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

  rejectObjectCycles(raw);

  let convertedFromSwagger2 = false;
  if (!('openapi' in raw)) {
    if ((raw as Record<string, unknown>).swagger === '2.0') {
      // Swagger 2.0: bundle external $refs from the original path/URL
      // FIRST so sibling refs ("./defs.yaml") resolve against the spec's
      // own location - after conversion the document only exists in
      // memory, where bundling would resolve against the process cwd
      // and ENOENT. Then convert to 3.x and run the same pipeline.
      // Servers come from host/basePath/schemes and securityDefinitions
      // become components.securitySchemes, so auth and base URL handling
      // are unchanged.
      const bundled2 = await withProtectedReferences(raw, options => $RefParser.bundle(input, raw as never, options));
      const { openapi } = await convertSwagger2(bundled2 as never, { patch: true, warnOnly: true } as never);
      raw = openapi;
      convertedFromSwagger2 = true;
    } else {
      throw new Error('Input does not look like an OpenAPI 3.x or Swagger 2.0 document (missing top-level "openapi"/"swagger").');
    }
  }

  // Bundle external $refs (files/URLs) into one document. Internal refs are
  // left as refs - Forge's resolver handles those. Bundle from the original
  // path/URL (not the parsed object) so relative external refs like
  // "../policies.yaml" resolve against the spec's own location. A
  // converted Swagger 2.0 document only exists in memory, so it bundles from
  // the object instead; refs relative to the spec's own location are
  // unsupported for 2.0 inputs (none of the major 2.0 publishers - Slack,
  // Kubernetes - use them).
  // A URL input is bundled from the document already fetched, with the URL
  // kept as the base for relative refs. Handing the bare URL to the parser
  // would make it fetch the root again through its safe-URL resolver, which
  // rejects loopback and private hosts and broke local dev specs (#168).
  const doc = (await withProtectedReferences(raw, bundleOptions => (convertedFromSwagger2
    ? $RefParser.bundle(raw as never, bundleOptions)
    : $RefParser.bundle(input as never, raw as never, bundleOptions)))) as unknown as OpenAPIV3.Document;

  // External YAML refs can introduce alias cycles not present in the root.
  rejectObjectCycles(doc);

  // Forge's operation indexer requires paths and components.schemas to exist;
  // real-world specs often omit components, and a webhook-only 3.1 spec may
  // omit paths entirely.
  const anyDoc = doc as unknown as Record<string, unknown>;
  if (typeof anyDoc.paths !== 'object' || anyDoc.paths === null) anyDoc.paths = {};
  if (typeof anyDoc.components !== 'object' || anyDoc.components === null) anyDoc.components = {};
  const components = anyDoc.components as Record<string, unknown>;
  if (typeof components.schemas !== 'object' || components.schemas === null) components.schemas = {};

  sanitizeComponentKeys(doc);
  hoistEscapedRefs(doc);
  inlinePathItemRefs(doc);
  breakAliasCycles(doc);

  // OpenAPI 3.1 upgrades schemas to JSON Schema 2020-12, where `type` may be
  // a union array. Forge reads `type` as a single string, so collapse unions
  // before the document reaches the resolver. The collapse runs for every
  // version (#88): a union in a 3.0.x document is off-spec, but without the
  // collapse Forge silently DROPS the property from the manifest - a
  // required field vanishes, the worst failure mode. Collapsing normalizes
  // the off-spec input into the same adapted form 3.1 gets.
  collapseTypeArrays(doc);

  ensureOperationIds(doc);
  return doc;
}


/** Reject YAML alias cycles before bundling and recursive normalization.
 * Shared acyclic aliases are valid; only edges back into the active path fail.
 * Use an explicit stack so detecting a deep graph does not itself overflow.
 */
function rejectObjectCycles(root: object): void {
  type Frame = { value: object; path: string; entries: [string, unknown][]; index: number };
  const active = new Map<object, string>();
  const complete = new WeakSet<object>();
  const frame = (value: object, path: string): Frame => ({ value, path, entries: Object.entries(value), index: 0 });
  const stack = [frame(root, '')];
  active.set(root, '');
  while (stack.length) {
    const current = stack[stack.length - 1]!;
    if (current.index === current.entries.length) {
      active.delete(current.value);
      complete.add(current.value);
      stack.pop();
      continue;
    }
    const [key, child] = current.entries[current.index++]!;
    if (!child || typeof child !== 'object') continue;
    const path = `${current.path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (active.has(child)) {
      throw new Error(`Input contains a cyclic object graph: ${path} points back to ${active.get(child) || '/'}. Recursive YAML aliases are not supported; use $ref for recursive schemas.`);
    }
    if (complete.has(child)) continue;
    active.set(child, path);
    stack.push(frame(child, path));
  }
}

type ReferenceContext = 'document' | 'components' | 'schema' | 'schemaMap' | 'other';
const REFERENCE_LITERAL_KEYS = new Set(['const', 'enum', 'default', 'example', 'examples']);
const REFERENCE_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const REFERENCE_SCHEMA_CHILD_KEYS = new Set(['items', 'additionalItems', 'prefixItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'contentSchema']);

function schemaReferenceContext(key: string): ReferenceContext | undefined {
  if (REFERENCE_LITERAL_KEYS.has(key)) return undefined;
  if (REFERENCE_SCHEMA_MAP_KEYS.has(key)) return 'schemaMap';
  if (REFERENCE_SCHEMA_CHILD_KEYS.has(key)) return 'schema';
  return 'other';
}

function childReferenceContext(context: ReferenceContext, key: string): ReferenceContext | undefined {
  if (context === 'schemaMap') return 'schema';
  if (key === '$ref') return undefined;
  if (context === 'schema') return schemaReferenceContext(key);
  if (context === 'document' && key === 'definitions') return 'schemaMap';
  if (context === 'document' && key === 'components') return 'components';
  if (context === 'components' && key === 'schemas') return 'schemaMap';
  return key === 'schema' ? 'schema' : 'other';
}

function visitReferenceObjects(node: unknown, context: ReferenceContext, visit: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visitReferenceObjects(item, context, visit);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (context !== 'schemaMap') visit(rec);
  for (const [key, value] of Object.entries(rec)) {
    const childContext = childReferenceContext(context, key);
    if (childContext !== undefined) visitReferenceObjects(value, childContext, visit);
  }
}

/** Visit reference-bearing objects without interpreting JSON Schema payload data. */
function walkReferenceObjects(root: unknown, visit: (node: Record<string, unknown>) => void): void {
  visitReferenceObjects(root, 'document', visit);
}

type ReferenceProtection = { restore: (() => void)[]; literals: WeakSet<object>; marker: string };

/** Hide literal $ref keys before RefParser sees either root or external data. */
function protectLiteralReferences(root: unknown, context: ReferenceContext, protection: ReferenceProtection, seen = new WeakSet<object>()): void {
  if (!root || typeof root !== 'object' || seen.has(root)) return;
  seen.add(root);
  if (Array.isArray(root)) {
    for (const child of root) protectLiteralReferences(child, context, protection, seen);
    return;
  }
  for (const [key, value] of Object.entries(root)) {
    const childContext = childReferenceContext(context, key);
    if (childContext !== undefined) protectLiteralReferences(value, childContext, protection, seen);
    else if (key !== '$ref') isolateLiteralPayload(root as Record<string, unknown>, key, value, protection);
  }
}

function isolateLiteralPayload(parent: Record<string, unknown>, key: string, value: unknown, protection: ReferenceProtection): void {
  // YAML aliases can also occur as real schemas. Protect a private data copy.
  if (value && typeof value === 'object' && protection.literals.has(value)) return;
  const literal = structuredClone(value);
  if (literal && typeof literal === 'object') protection.literals.add(literal);
  parent[key] = literal;
  hideLiteralReferenceKeys(literal, protection);
}

function hideLiteralReferenceKeys(root: unknown, protection: ReferenceProtection, seen = new WeakSet<object>()): void {
  if (!root || typeof root !== 'object' || seen.has(root)) return;
  seen.add(root);
  const rec = root as Record<string, unknown>;
  if (Object.hasOwn(rec, '$ref')) {
    const value = rec.$ref;
    delete rec.$ref;
    rec[protection.marker] = value;
    protection.restore.push(() => { delete rec[protection.marker]; rec.$ref = value; });
  }
  for (const value of Object.values(rec)) hideLiteralReferenceKeys(value, protection, seen);
}

function protectedParser(plugin: Plugin, protection: ReferenceProtection): Plugin {
  const parse = plugin.parse as (file: FileInfo) => unknown | Promise<unknown>;
  return { ...plugin, async parse(file: FileInfo) {
    const value = await parse.call(plugin, file);
    const rec = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    const context = rec && ('openapi' in rec || 'swagger' in rec) ? 'document' : 'schema';
    protectLiteralReferences(value, context, protection);
    // A fragment may select a schema from an otherwise untyped external map.
    if (file.hash.startsWith('#/')) {
      let target: unknown = value;
      for (const segment of file.hash.slice(2).split('/')) {
        const key = decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~');
        target = target && typeof target === 'object' ? (target as Record<string, unknown>)[key] : undefined;
      }
      protectLiteralReferences(target, 'schema', protection);
    }
    return value;
  } };
}

async function withProtectedReferences<T>(root: unknown, run: (options: ReturnType<typeof referenceParserOptions>) => Promise<T>): Promise<T> {
  const protection: ReferenceProtection = { restore: [], literals: new WeakSet(), marker: `x-spec2mcp-literal-${randomUUID()}` };
  protectLiteralReferences(root, 'document', protection);
  try {
    const result = await run(referenceParserOptions(protection));
    restoreCopiedLiteralReferences(result, protection.marker);
    return result;
  }
  finally { for (const restoreKey of protection.restore) restoreKey(); }
}

function restoreCopiedLiteralReferences(root: unknown, marker: string): void {
  const seen = new WeakSet<object>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if (Object.hasOwn(rec, marker)) {
      rec.$ref = rec[marker];
      delete rec[marker];
    }
    for (const value of Object.values(rec)) stack.push(value);
  }
}

function referenceParserOptions(protection: ReferenceProtection) {
  const defaults = getJsonSchemaRefParserDefaultOptions();
  return {
    dereference: { circular: 'ignore' as const },
    parse: {
      json: protectedParser(defaults.parse.json as Plugin, protection),
      yaml: protectedParser(defaults.parse.yaml as Plugin, protection),
    },
  };
}

/**
 * JSON Pointer escape normalization (#96). The vendored resolver walks
 * `#/...` $ref segments literally - resolveDocRef never decodes `~1`/`~0` -
 * so a $ref to a component key containing "/" or "~" fails to resolve and
 * the schema collapses to an open `{type: "object"}` with no properties.
 * (Forge's resolveSchemaRef unescapes correctly, so parameter refs are
 * fine; only doc-path walks miss.) Rather than patch the vendored code,
 * normalize at load: rename the affected component keys to escape-free
 * unique names and rewrite every internal $ref that targets them, so the
 * literal walk and the unescaping walk agree.
 */
function sanitizeComponentKeys(doc: OpenAPIV3.Document): void {
  const components = (doc as unknown as Record<string, unknown>).components as Record<string, unknown> | undefined;
  if (!components || typeof components !== 'object') return;
  const renames = new Map<string, string>();
  for (const [section, bucket] of Object.entries(components)) {
    // Security requirement keys reference scheme names, not JSON Pointers.
    // Keep those names intact; the auth resolver decodes pointer escapes.
    if (section === 'securitySchemes') continue;
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    const rec = bucket as Record<string, unknown>;
    const taken = new Set(Object.keys(rec));
    for (const key of Object.keys(rec)) {
      if (!key.includes('/') && !key.includes('~')) continue;
      let candidate = key.replaceAll('/', '_').replaceAll('~', '_');
      while (taken.has(candidate)) candidate += '_';
      taken.add(candidate);
      rec[candidate] = rec[key];
      delete rec[key];
      // JSON Pointer escaping order: "~" first, then "/".
      const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
      renames.set(`#/components/${section}/${escaped}`, `#/components/${section}/${candidate}`);
    }
  }
  if (renames.size === 0) return;
  walkReferenceObjects(doc, rec => {
    const value = rec.$ref;
    if (typeof value !== 'string') return;
    for (const [oldRef, newRef] of renames) {
      if (value === oldRef || value.startsWith(`${oldRef}/`)) {
        rec.$ref = newRef + value.slice(oldRef.length);
        break;
      }
    }
  });
}


/**
 * Deep escaped pointer segments (#112). sanitizeComponentKeys covers the
 * component key itself; a $ref can also carry escaped segments BELOW it
 * (`#/components/schemas/Foo/properties/a~1b`), which the vendored
 * resolver's literal walk cannot follow. Hoist the target instead of
 * patching vendored code: decode the pointer properly, copy the target
 * into a synthetic escape-free component, and rewrite the $ref to point at
 * it. The original document is untouched, so wire field names keep their
 * exact spelling.
 */
function hoistEscapedRefs(doc: OpenAPIV3.Document): void {
  const root = doc as unknown as Record<string, unknown>;
  const components = root.components as Record<string, unknown> | undefined;
  const schemas = components?.schemas as Record<string, unknown> | undefined;
  if (!schemas || typeof schemas !== 'object') return;

  const decodeSegment = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~');
  const resolvePointer = (ref: string): unknown => {
    if (!ref.startsWith('#/')) return undefined;
    let cur: unknown = root;
    for (const segment of ref.slice(2).split('/').map(decodeSegment)) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[segment];
    }
    return cur;
  };

  // Pass 1: collect escaped refs and their synthetic names. Object key
  // order makes the walk - and therefore the generated names - deterministic.
  const rewrites = new Map<string, string>();
  walkReferenceObjects(doc, rec => {
    const value = rec.$ref;
    if (typeof value !== 'string' || !value.includes('~') || rewrites.has(value)) return;
    const target = resolvePointer(value);
    if (target && typeof target === 'object') {
      const tail = decodeSegment(value.split('/').pop() ?? 'ref').replace(/[^A-Za-z0-9_-]+/g, '_') || 'ref';
      let name = `Hoisted_${tail}`;
      let n = 2;
      while (name in schemas) name = `Hoisted_${tail}_${n++}`;
      schemas[name] = target;
      rewrites.set(value, `#/components/schemas/${name}`);
    }
  });
  if (rewrites.size === 0) return;

  // Pass 2: rewrite. Runs after the hoist, so synthetic components are not
  // re-collected; refs inside them were already collected in pass 1.
  walkReferenceObjects(doc, rec => {
    if (typeof rec.$ref !== 'string') return;
    const replacement = rewrites.get(rec.$ref);
    if (replacement) rec.$ref = replacement;
  });
}

function resolveLocalPointer(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  const decodeSegment = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~');
  let target: unknown = root;
  for (const segment of ref.slice(2).split('/').map(decodeSegment)) {
    if (!target || typeof target !== 'object') return undefined;
    target = (target as Record<string, unknown>)[segment];
  }
  return target;
}

/**
 * Follow a path item alias chain to its final item. Returns the final target
 * (undefined when the chain is cyclic or unresolvable) and the sibling fields
 * collected along the way, with outer siblings winning.
 */
function followPathItemAliases(
  root: Record<string, unknown>,
  first: unknown,
  ref: string,
  outerSiblings: Record<string, unknown>,
): { target: unknown; siblings: Record<string, unknown> } {
  const visited = new Set<string>([ref]);
  let target = first;
  let siblings = outerSiblings;
  while (target && typeof target === 'object' && typeof (target as Record<string, unknown>).$ref === 'string') {
    const { $ref: aliasRef, ...aliasSiblings } = target as Record<string, unknown>;
    siblings = { ...aliasSiblings, ...siblings };
    if (visited.has(aliasRef as string)) return { target: undefined, siblings };
    visited.add(aliasRef as string);
    target = resolveLocalPointer(root, aliasRef as string);
  }
  return { target, siblings };
}

/**
 * Referenced Path Item Objects (#134). OpenAPI 3.1 allows a `paths` entry to
 * be a $ref into `components.pathItems`; neither the ID repair below nor
 * Forge's operation indexer follows that reference, so every operation under
 * the path silently vanishes. Inline the target at load - a deep clone, since
 * one component can back several paths and ID repair mutates per path -
 * keeping the referencing path as the wire path, and preserving any sibling
 * fields next to the $ref (3.1 permits summary/description overrides). An
 * unresolvable reference is surfaced loudly instead of dropping the path.
 */
function inlinePathItemRefs(doc: OpenAPIV3.Document): void {
  const root = doc as unknown as Record<string, unknown>;
  const paths = root.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== 'object') return;
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const { $ref: ref, ...outerSiblings } = pathItem as Record<string, unknown>;
    if (typeof ref !== 'string') continue;
    const first = resolveLocalPointer(root, ref);
    if (!first || typeof first !== 'object') {
      console.error(`warning: cannot resolve referenced path item "${ref}" for path "${path}"; its operations will be missing.`);
      continue;
    }
    const { target, siblings } = followPathItemAliases(root, first, ref, outerSiblings);
    if (!target || typeof target !== 'object') {
      console.error(`warning: cannot resolve referenced path item alias chain for path "${path}"; its operations will be missing.`);
      continue;
    }
    paths[path] = structuredClone({ ...target, ...siblings });
  }
}

/**
 * Reference alias cycles (#148). A $ref chain that never reaches a concrete
 * schema (A -> B -> A) recurses the vendored resolver's alias walk until the
 * process dies with RangeError: Maximum call stack size exceeded. Detect
 * pure-alias chains at load and rewrite any ref that cannot reach a
 * concrete target to a dangling pointer, so downstream handling matches
 * unresolved-$ref behavior (#112: warnings, text-only tools) instead of a
 * process-level crash. An alias is an object whose only key is $ref; a ref
 * whose target is missing is already dangling and left alone.
 */
function breakAliasCycles(doc: OpenAPIV3.Document): void {
  const root = doc as unknown as Record<string, unknown>;
  const decodeSegment = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~');
  const resolvePointer = (ref: string): unknown => {
    if (!ref.startsWith('#/')) return undefined;
    let cur: unknown = root;
    for (const segment of ref.slice(2).split('/').map(decodeSegment)) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[segment];
    }
    return cur;
  };
  const aliasTarget = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    const rec = node as Record<string, unknown>;
    const keys = Object.keys(rec);
    return keys.length === 1 && typeof rec.$ref === 'string' && rec.$ref.startsWith('#/') ? rec.$ref : undefined;
  };

  // Collect every internal $ref in the document.
  const refs = new Set<string>();
  walkReferenceObjects(root, rec => {
    if (typeof rec.$ref === 'string' && rec.$ref.startsWith('#/')) refs.add(rec.$ref);
  });

  const broken = new Set<string>();
  for (const ref of refs) {
    const chain: string[] = [];
    const visited = new Set<string>();
    let cur: string | undefined = ref;
    let cyclic = false;
    while (cur !== undefined) {
      if (visited.has(cur)) {
        cyclic = true;
        break;
      }
      visited.add(cur);
      chain.push(cur);
      const target = resolvePointer(cur);
      if (target === undefined) break; // already dangling: unresolved, not a cycle
      cur = aliasTarget(target);
    }
    if (cyclic) for (const r of chain) broken.add(r);
  }
  if (broken.size === 0) return;

  for (const ref of broken) {
    console.error(`warning: reference alias cycle involving "${ref}" never reaches a concrete schema; treating it as unresolvable.`);
  }
  walkReferenceObjects(root, rec => {
    const value = rec.$ref;
    if (typeof value === 'string' && broken.has(value)) {
      rec.$ref = `#/invalid-alias-cycle/${value.split('/').pop()}`;
    }
  });
}

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

function isJsonSchemaTypeArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((t) => typeof t === 'string' && JSON_SCHEMA_TYPES.has(t));
}

function collapseSchemaChildren(key: string, value: unknown): void {
  if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key) && value && typeof value === 'object') {
    for (const schema of Object.values(value)) collapseTypeArrays(schema);
  } else {
    collapseTypeArrays(value);
  }
}

function preserveAnyOfIntersection(schema: Record<string, unknown>): void {
  if (!Array.isArray(schema.anyOf)) return;
  const existing = Array.isArray(schema.allOf) ? schema.allOf : [];
  schema.allOf = [...existing, { anyOf: schema.anyOf }];
}

/**
 * Collapse JSON Schema 2020-12 type unions so Forge can type the schema:
 * `["string", "null"]` becomes `type: "string"` (a nullable parameter simply
 * is not required), and a union of several non-null types becomes an `anyOf`
 * of single-type branches, which the resolver already understands.
 * Nullability must survive the collapse (#81): Forge ignores the OpenAPI
 * `nullable` keyword, so it is safe to keep as a normalized internal marker,
 * and the manifest's schema pipeline turns it back into the standard union
 * form for advertised input/output schemas. Dropping it silently made the
 * runtime reject valid null responses and null request fields.
 * `example`/`examples`/`const`/`enum`/`default` hold payload data, not schemas - a property
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
    const nullable = rec.type.includes('null');
    const nonNull = rec.type.filter((t) => t !== 'null');
    if (nonNull.length === 1) {
      rec.type = nonNull[0];
      if (nullable) rec.nullable = true;
    } else if (nonNull.length > 1) {
      preserveAnyOfIntersection(rec);
      rec.anyOf = nonNull.map((t) => ({ type: t }));
      delete rec.type;
      if (nullable) rec.nullable = true;
    }
  }
  for (const [key, value] of Object.entries(rec)) {
    if (['example', 'examples', 'const', 'enum', 'default'].includes(key)) continue;
    collapseSchemaChildren(key, value);
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
 * YAML aliases can share path items or operations between paths. Detach
 * repeated containers so repairing one occurrence cannot overwrite another.
 */
function detachSharedOperations(doc: OpenAPIV3.Document): void {
  const pathItems = new WeakSet<object>();
  const operations = new WeakSet<object>();
  for (const [path, original] of Object.entries(doc.paths ?? {})) {
    if (!original || typeof original !== 'object') continue;
    const item = pathItems.has(original) ? { ...original } : original;
    pathItems.add(original);
    doc.paths[path] = item;
    detachSharedMethods(item, operations);
  }
}

function detachSharedMethods(item: OpenAPIV3.PathItemObject, operations: WeakSet<object>): void {
  for (const method of HTTP_METHODS) {
    const operation = item[method];
    if (!operation || typeof operation !== 'object') continue;
    if (operations.has(operation)) item[method] = { ...operation };
    operations.add(operation);
  }
}

/**
 * Forge indexes operations by operationId and silently skips operations that
 * have none. Many real-world specs omit them. Synthesise stable ids from
 * method + path so every operation becomes a tool, and uniquify collisions.
 */
export function ensureOperationIds(doc: OpenAPIV3.Document): void {
  detachSharedOperations(doc);
  const seen = new Set<string>();
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OpenAPIV3.OperationObject | undefined;
      if (!op || typeof op !== 'object') continue;
      // Forge strips apostrophes from its operation index keys. Repair against
      // that same key so distinct source IDs cannot collide at init.
      let id = (typeof op.operationId === 'string' && op.operationId.length > 0 ? op.operationId : synthesizeId(method, path)).replace(/'/g, '');
      if (!id) id = synthesizeId(method, path);
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

/**
 * Local files a spec pulls in through external $refs (excluding the root
 * itself), so `--watch` can regenerate when one of them changes (#156).
 */
export async function localRefDependencies(input: string): Promise<string[]> {
  if (/^https?:\/\//i.test(input)) return [];
  const text = await readFile(input, 'utf8');
  const raw = parseYaml(text);
  rejectObjectCycles(raw);
  const refs = await withProtectedReferences(raw, options => $RefParser.resolve(input, raw, options)) as unknown as { paths(...types: string[]): string[] };
  const root = resolvePath(input);
  return refs.paths('file').map((file: string) => resolvePath(file)).filter((file: string) => file !== root);
}

/** Overlay references are data: collect local paths without resolving or reading targets. */
export async function localOverlayReferencePaths(spec: string, paths: string[]): Promise<string[]> {
  if (/^https?:\/\//i.test(spec)) return [];
  const result = new Set<string>();
  const base = dirname(resolvePath(spec));
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        if (value.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
        const file = value.split('#', 1)[0];
        if (file) result.add(resolvePath(base, file));
      } else walk(value);
    }
  };
  for (const file of await loadOverlays(paths)) walk(file.overlay);
  return [...result];
}
