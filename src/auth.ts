/**
 * Auth mapping: OpenAPI securitySchemes -> environment variables the
 * generated server reads at call time. Nothing secret is ever generated.
 */
import type { OpenAPIV3 } from 'openapi-types';
import { toEnvSuffix } from './naming.js';

export type AuthScheme =
  | { kind: 'bearer'; schemeName: string; envVar: string }
  | { kind: 'basic'; schemeName: string; envVar: string }
  | { kind: 'apikey-header'; schemeName: string; envVar: string; headerName: string }
  | { kind: 'apikey-query'; schemeName: string; envVar: string; queryName: string };

export type AuthPlan = {
  /** Union of the schemes used by tools, for generated setup instructions. */
  schemes: AuthScheme[];
  /** Warnings about unresolved security requirements, emitted at generation time. */
  warnings: string[];
  baseUrlEnvVar: string;
};

/** Join prefix and scheme suffix without stutter: CLOUDFLARE_API + API_TOKEN
 * becomes CLOUDFLARE_API_TOKEN, not CLOUDFLARE_API_API_TOKEN. */
export function joinEnvName(prefix: string, suffix: string): string {
  if (suffix.startsWith(`${prefix}_`)) return suffix;
  const prefixParts = prefix.split('_');
  const suffixParts = suffix.split('_');
  let overlap = 0;
  for (let k = Math.min(prefixParts.length, suffixParts.length); k > 0; k--) {
    if (prefixParts.slice(-k).join('_') === suffixParts.slice(0, k).join('_')) {
      overlap = k;
      break;
    }
  }
  const trimmed = suffixParts.slice(overlap).join('_');
  return trimmed ? `${prefix}_${trimmed}` : prefix;
}

function mapScheme(name: string, def: OpenAPIV3.SecuritySchemeObject, envPrefix: string): AuthScheme | undefined {
  const envVar = joinEnvName(envPrefix, toEnvSuffix(name));
  if (def.type === 'http' && def.scheme?.toLowerCase() === 'bearer') {
    return { kind: 'bearer', schemeName: name, envVar };
  }
  if (def.type === 'http' && def.scheme?.toLowerCase() === 'basic') {
    return { kind: 'basic', schemeName: name, envVar };
  }
  if (def.type === 'apiKey' && def.in === 'header' && def.name) {
    return { kind: 'apikey-header', schemeName: name, envVar, headerName: def.name };
  }
  if (def.type === 'apiKey' && def.in === 'query' && def.name) {
    return { kind: 'apikey-query', schemeName: name, envVar, queryName: def.name };
  }
  if (def.type === 'oauth2' || def.type === 'openIdConnect') {
    return { kind: 'bearer', schemeName: name, envVar };
  }
  // Other HTTP schemes (digest, NTLM, ...) need a challenge-response
  // exchange, not a static Authorization header (#136). Mapping them to
  // bearer would send a syntactically valid but semantically wrong header
  // with no warning, so leave them unmapped and let the caller warn.
  return undefined;
}

/** Follow an internal `#/...` security-scheme reference, decoding JSON Pointer escapes. */
function resolveSecuritySchemeRef(doc: OpenAPIV3.Document, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = doc;
  for (const segment of ref.slice(2).split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** Select an operation's first usable OR alternative; each object's keys are AND requirements.
 * An explicit empty security array (or empty requirement) means anonymous access.
 * For legacy specs with no security declaration, one declared scheme is inferred.
 */
export function buildAuthPlan(doc: OpenAPIV3.Document, envPrefix: string): {
  auth: AuthPlan;
  forOperation: (operation: OpenAPIV3.OperationObject, label: string) => { names: string[]; alternatives: string[][] };
} {
  const definitions = doc.components?.securitySchemes ?? {};
  const mapped = new Map<string, AuthScheme>();
  const unsupported: string[] = [];
  for (const [name, def] of Object.entries(definitions)) {
    if (!def) continue;
    // A scheme may be a $ref alias to another scheme (#135). Follow internal
    // references - tracking visited refs against alias cycles - keeping the alias
    // as the scheme name so the operation and its env var use the name the
    // spec's security requirements reference. An unresolvable alias stays
    // unmapped, and forOperation's missing-scheme warning names it.
    let resolved: unknown = def;
    const visited = new Set<string>();
    while (resolved && typeof resolved === 'object' && '$ref' in resolved) {
      const ref = (resolved as { $ref: string }).$ref;
      if (visited.has(ref)) break;
      visited.add(ref);
      resolved = resolveSecuritySchemeRef(doc, ref);
    }
    if (resolved && typeof resolved === 'object' && !('$ref' in resolved)) {
      const scheme = mapScheme(name, resolved as OpenAPIV3.SecuritySchemeObject, envPrefix);
      if (scheme) mapped.set(name, scheme);
      else {
        const def = resolved as OpenAPIV3.SecuritySchemeObject;
        const shape = def.type === 'http' ? `http ${def.scheme}` : String(def.type);
        unsupported.push(`security scheme "${name}" uses unsupported auth (${shape}) and was not mapped; only HTTP bearer/basic, header/query API keys, and OAuth/OIDC bearer tokens are supported.`);
      }
    }
  }
  // Two scheme names can normalize to the same env var ("api-key" and
  // "api_key" both become API_KEY): one shared variable sends the same
  // secret to both headers with no way to configure them independently
  // (#101). Allocate deterministically in byte order by scheme name: the
  // first claimant keeps the base name, later ones advance a numeric
  // suffix until the name is free (#106). "Free" means neither already
  // allocated nor another scheme's base name - "api_key_2" normalizes to
  // API_KEY_2, so a suffix landing there would collide again - and the
  // base URL variable is reserved up front.
  const baseNames = new Set([...mapped.values()].map((scheme) => scheme.envVar));
  const allocated = new Set<string>([`${envPrefix}_BASE_URL`]);
  for (const name of [...mapped.keys()].sort()) {
    const scheme = mapped.get(name)!;
    let candidate = scheme.envVar;
    if (allocated.has(candidate)) {
      let n = 2;
      candidate = `${scheme.envVar}_${n}`;
      while (allocated.has(candidate) || (baseNames.has(candidate) && candidate !== scheme.envVar)) {
        candidate = `${scheme.envVar}_${++n}`;
      }
    }
    scheme.envVar = candidate;
    allocated.add(candidate);
  }
  const auth: AuthPlan = { schemes: [], warnings: [...unsupported], baseUrlEnvVar: `${envPrefix}_BASE_URL` };
  const used = new Set<string>();
  const fallback = mapped.size === 1 ? [...mapped.keys()][0] : undefined;

  function forOperation(operation: OpenAPIV3.OperationObject, label: string): { names: string[]; alternatives: string[][] } {
    const security = operation.security ?? doc.security;
    // A missing declaration differs from security: security: [], which expressly disables auth.
    const alternatives = security === undefined
      ? (fallback ? [{ [fallback]: [] }] : [])
      : security;
    // Prefer a fully mapped OR alternative to a broken one, rather than
    // silently dropping part of an AND requirement when another route exists.
    // Every fully mapped alternative is preserved in spec order (#146): the
    // runtime picks the first whose credentials are all configured, so a
    // usable later route is not discarded with an unset first one.
    const complete = alternatives
      .map((requirement) => Object.keys(requirement).filter((name) => mapped.has(name)))
      .filter((names, i) => names.length === Object.keys(alternatives[i]!).length);
    const requirement = complete.length > 0 ? undefined : alternatives[0];
    const groups: string[][] = [...complete];
    if (requirement) {
      const names: string[] = [];
      for (const name of Object.keys(requirement)) {
        if (mapped.has(name)) {
          names.push(name);
        } else {
          auth.warnings.push(`${label}: security scheme "${name}" is missing or unsupported; ${fallback && fallback !== name ? `using "${fallback}"` : 'continuing without it'}`);
          if (fallback && !names.includes(fallback)) names.push(fallback);
        }
      }
      groups.push(names);
    }
    const names = groups[0] ?? [];
    for (const group of groups) {
      for (const name of group) {
        if (!used.has(name)) {
          used.add(name);
          auth.schemes.push(mapped.get(name)!);
        }
      }
    }
    return { names, alternatives: groups };
  }
  return { auth, forOperation };
}
