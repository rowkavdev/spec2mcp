import type { OpenAPIV3 } from 'openapi-types';

// Private identity provenance. Never serialize it into a source document or
// infer it for objects introduced by bundling, cloning or overlays.
const origins = new WeakMap<object, { url: string; template: string; variables: string }>();
export function captureRootServerOrigins(raw: unknown, sourceUrl: string): void {
  if (!/^https?:\/\//i.test(sourceUrl) || !raw || typeof raw !== 'object') return;
  const root = raw as Record<string, unknown>;
  if (root.$ref || !root.openapi) return;
  const capture = (owner: Record<string, unknown>): void => {
    if (owner.$ref || !Array.isArray(owner.servers)) return;
    for (const server of owner.servers) if (server && typeof server === 'object' && !server.$ref) origins.set(server, { url: sourceUrl, template: server.url, variables: JSON.stringify(server.variables) });
  };
  capture(root);
  if (!root.paths || typeof root.paths !== 'object') return;
  for (const item of Object.values(root.paths)) {
    if (!item || typeof item !== 'object' || item.$ref) continue;
    capture(item);
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      const operation = item[method];
      if (operation && typeof operation === 'object') capture(operation);
    }
  }
}
export function sourceServerUrl(server: OpenAPIV3.ServerObject, expanded: string): string {
  const origin = origins.get(server);
  if (!origin || server.url !== origin.template || JSON.stringify(server.variables) !== origin.variables) return expanded;
  // Absolute and invalid URLs keep their existing interpretation. Only a
  // proven relative URL is resolved against this exact serving document.
  if (/^[a-z][a-z0-9+.-]*:/i.test(expanded)) return expanded;
  try { return new URL(expanded, origin.url).href; } catch { return expanded; }
}
