/**
 * OpenAPI Overlay application (Overlay Specification v1.0.0 actions subset).
 *
 * Forge's own applyForgeOverlays serves its cf-CLI command-tree pipeline: it
 * expects x-forge-commands in every overlay and drops (or rejects) overlays
 * that only curate operations. spec2mcp needs the opposite - rename, describe
 * and remove operations before tool generation - so it applies the standard
 * overlay actions itself: each action targets nodes by JSONPath, then deep-
 * merges an `update` or deletes the node with `remove: true`. A target that
 * matches nothing is a curation typo and fails loudly.
 */
import { JSONPath } from 'jsonpath-plus';
import type { OpenAPIV3 } from 'openapi-types';
import type { ApiOverlayFile } from '../vendor/forge/index.js';

type OverlayAction = { target?: unknown; update?: unknown; remove?: unknown };

export function applyOverlays(doc: OpenAPIV3.Document, overlays: ApiOverlayFile[]): OpenAPIV3.Document {
  for (const { name, overlay } of overlays) {
    overlay.actions.forEach((action, i) => {
      const { target, update, remove } = action as OverlayAction;
      if (typeof target !== 'string' || target.length === 0) {
        throw new Error(`Overlay ${name} action ${i + 1} is missing a string "target".`);
      }
      const matches = JSONPath({
        path: target,
        json: doc as unknown as object,
        resultType: 'all',
        wrap: true,
      }) as { value: unknown; parent: Record<string, unknown> | unknown[] | null; parentProperty: string | number | null }[];
      if (matches.length === 0) {
        throw new Error(`Overlay ${name} action ${i + 1} target matched nothing in the spec: ${target}`);
      }
      for (const match of matches) {
        if (remove === true) {
          if (match.parent !== null && match.parentProperty !== null) {
            if (Array.isArray(match.parent) && typeof match.parentProperty === 'number') match.parent.splice(match.parentProperty, 1);
            else delete (match.parent as Record<string, unknown>)[String(match.parentProperty)];
          }
        } else if (update !== undefined) {
          if (typeof match.value !== 'object' || match.value === null || Array.isArray(match.value)) {
            throw new Error(`Overlay ${name} action ${i + 1} target must resolve to an object for "update": ${target}`);
          }
          deepMerge(match.value as Record<string, unknown>, update);
        }
      }
    });
  }
  return doc;
}

function deepMerge(target: Record<string, unknown>, update: unknown): void {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) {
    throw new Error('Overlay "update" must be an object to merge into its target.');
  }
  for (const [key, value] of Object.entries(update)) {
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) deepMerge(existing as Record<string, unknown>, value);
    else target[key] = value;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
