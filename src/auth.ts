/**
 * Auth mapping: OpenAPI securitySchemes -> environment variables the
 * generated server reads at call time. Nothing secret is ever generated;
 * the README and .env.example tell the user exactly what to set.
 */
import type { OpenAPIV3 } from 'openapi-types';
import { toEnvPrefix, toEnvSuffix } from './naming.js';

export type AuthScheme =
  | { kind: 'bearer'; schemeName: string; envVar: string }
  | { kind: 'basic'; schemeName: string; envVar: string }
  | { kind: 'apikey-header'; schemeName: string; envVar: string; headerName: string }
  | { kind: 'apikey-query'; schemeName: string; envVar: string; queryName: string };

export type AuthPlan = {
  schemes: AuthScheme[];
  /** Env var that overrides the spec's server URL at runtime. */
  baseUrlEnvVar: string;
};

/**
 * Build the auth plan for the whole API. MVP scope: the first root-level
 * security requirement (OpenAPI security is an OR list; AND members each
 * get a scheme). APIs with no security get an empty plan. Per-operation
 * security overrides are a roadmap item.
 */
export function buildAuthPlan(doc: OpenAPIV3.Document, envPrefix: string): AuthPlan {
  const plan: AuthPlan = { schemes: [], baseUrlEnvVar: `${envPrefix}_BASE_URL` };
  const schemes = doc.components?.securitySchemes ?? {};
  const requirement = doc.security?.[0] ?? {};
  const wanted = new Set(Object.keys(requirement));
  // No root security block: still map declared schemes if exactly one exists,
  // which is the common "declared but not referenced" shape in small specs.
  const names = wanted.size > 0 ? [...wanted] : Object.keys(schemes).slice(0, wanted.size === 0 && Object.keys(schemes).length === 1 ? 1 : 0);

  for (const name of names) {
    const def = schemes[name];
    if (!def || typeof def !== 'object' || '$ref' in def) continue;
    const envVar = `${envPrefix}_${toEnvSuffix(name)}`;
    if (def.type === 'http' && def.scheme?.toLowerCase() === 'bearer') {
      plan.schemes.push({ kind: 'bearer', schemeName: name, envVar });
    } else if (def.type === 'http' && def.scheme?.toLowerCase() === 'basic') {
      plan.schemes.push({ kind: 'basic', schemeName: name, envVar });
    } else if (def.type === 'apiKey' && def.in === 'header' && def.name) {
      plan.schemes.push({ kind: 'apikey-header', schemeName: name, envVar, headerName: def.name });
    } else if (def.type === 'apiKey' && def.in === 'query' && def.name) {
      plan.schemes.push({ kind: 'apikey-query', schemeName: name, envVar, queryName: def.name });
    } else if (def.type === 'oauth2' || def.type === 'openIdConnect' || def.type === 'http') {
      // OAuth2/OIDC/other http schemes: a pre-minted access token goes in as a bearer.
      plan.schemes.push({ kind: 'bearer', schemeName: name, envVar });
    }
    // mutualTLS and apiKey-in-cookie have no env mapping; documented as unsupported.
  }
  return plan;
}
