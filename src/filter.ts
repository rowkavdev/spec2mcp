/** Select OpenAPI operations by exact tag or operationId glob. */
export type OperationFilters = { include?: string[]; exclude?: string[] };

function matches(selector: string, operationId: string, tags: readonly string[]): boolean {
  const tagOnly = selector.startsWith('tag:');
  const operationOnly = selector.startsWith('operation:');
  const value = selector.slice(tagOnly ? 4 : operationOnly ? 10 : 0);
  if (!value) return false;
  if (!operationOnly && tags.includes(value)) return true;
  if (tagOnly) return false;
  const pattern = `^${[...value].map((char) => {
    if (char === '*') return '.*';
    if (char === '?') return '.';
    return char.replace(/[\\^$+.()|[\]{}]/g, '\\$&');
  }).join('')}(?![\\s\\S])`;
  return new RegExp(pattern, 'su').test(operationId);
}

export function operationIncluded(
  operationId: string,
  tags: readonly string[],
  filters: OperationFilters = {},
): boolean {
  const include = filters.include ?? [];
  const exclude = filters.exclude ?? [];
  return (include.length === 0 || include.some((selector) => matches(selector, operationId, tags))) &&
    !exclude.some((selector) => matches(selector, operationId, tags));
}

export function operationTags(doc: { paths?: Record<string, unknown> }): Map<string, string[]> {
  const tags = new Map<string, string[]>();
  for (const item of Object.values(doc.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']) {
      const operation = (item as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object') continue;
      const { operationId, tags: rawTags } = operation as Record<string, unknown>;
      if (typeof operationId === 'string') {
        tags.set(operationId, Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === 'string') : []);
      }
    }
  }
  return tags;
}
