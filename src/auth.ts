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

function mapScheme(name: string, def: OpenAPIV3.SecuritySchemeObject, envPrefix: string): AuthScheme | undefined {
  const envVar = `${envPrefix}_${toEnvSuffix(name)}`;
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
  if (def.type === 'oauth2' || def.type === 'openIdConnect' || def.type === 'http') {
    return { kind: 'bearer', schemeName: name, envVar };
  }
  return undefined;
}

/** Select an operation's first usable OR alternative; each object's keys are AND requirements.
 * An explicit empty security array (or empty requirement) means anonymous access.
 * For legacy specs with no security declaration, one declared scheme is inferred.
 */
export function buildAuthPlan(doc: OpenAPIV3.Document, envPrefix: string): {
  auth: AuthPlan;
  forOperation: (operation: OpenAPIV3.OperationObject, label: string) => string[];
} {
  const definitions = doc.components?.securitySchemes ?? {};
  const mapped = new Map<string, AuthScheme>();
  for (const [name, def] of Object.entries(definitions)) {
    if (def && !('$ref' in def)) {
      const scheme = mapScheme(name, def, envPrefix);
      if (scheme) mapped.set(name, scheme);
    }
  }
  const auth: AuthPlan = { schemes: [], warnings: [], baseUrlEnvVar: `${envPrefix}_BASE_URL` };
  const used = new Set<string>();
  const fallback = mapped.size === 1 ? [...mapped.keys()][0] : undefined;

  function forOperation(operation: OpenAPIV3.OperationObject, label: string): string[] {
    const security = operation.security ?? doc.security;
    // A missing declaration differs from security: [], which expressly disables auth.
    const alternatives = security === undefined
      ? (fallback ? [{ [fallback]: [] }] : [])
      : security;
    // Prefer a fully mapped OR alternative to a broken one, rather than
    // silently dropping part of an AND requirement when another route exists.
    const complete = alternatives.find((requirement) =>
      Object.keys(requirement).every((name) => mapped.has(name)));
    const requirement = complete ?? alternatives[0];
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
      for (const name of names) {
        if (!used.has(name)) {
          used.add(name);
          auth.schemes.push(mapped.get(name)!);
        }
      }
      return names;
    }
    return [];
  }
  return { auth, forOperation };
}
