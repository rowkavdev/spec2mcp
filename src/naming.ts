/**
 * Naming helpers for MCP-safe identifiers.
 *
 * MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$. OpenAPI operationIds are
 * usually camelCase or kebab-case, sometimes with dots, colons or spaces.
 */

/** Convert an arbitrary operationId to an MCP-safe snake_case tool name. */
export function toToolName(operationId: string): string {
  let s = operationId
    // camelCase / PascalCase boundaries
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // anything not alnum becomes an underscore (keep hyphens? underscores read better)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
  if (s.length === 0) s = 'operation';
  // must not start with a digit for readability in some clients
  if (/^[0-9]/.test(s)) s = `op_${s}`;
  if (s.length > 64) s = s.slice(0, 64).replace(/_+$/g, '');
  return s;
}

/** Deduplicate tool names by appending _2, _3, ... */
export function dedupeNames(names: string[]): string[] {
  const emitted = new Set<string>();
  return names.map((name) => {
    // Reserve the actual emitted name, not merely its unsuffixed source:
    // "foo_bar", "foo_bar", "foo_bar_2" must all stay distinct.
    let candidate = name.slice(0, 64);
    let suffix = 2;
    while (emitted.has(candidate)) {
      const ending = `_${suffix++}`;
      candidate = `${name.slice(0, 64 - ending.length)}${ending}`;
    }
    emitted.add(candidate);
    return candidate;
  });
}

/** UPPER_SNAKE env-var safe rendering of an API title, e.g. "Pet Store" -> PET_STORE. */
export function toEnvPrefix(title: string): string {
  const s = title
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return s.length > 0 ? s : 'API';
}

/** UPPER_SNAKE rendering of a scheme name, e.g. "bearerAuth" -> BEARER_AUTH. */
export function toEnvSuffix(name: string): string {
  return toEnvPrefix(name);
}

/** kebab-case for generated package names. */
export function toKebab(name: string): string {
  const s = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .toLowerCase();
  return s.length > 0 ? s : 'api';
}
