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
      if (remove === true) {
        // JSONPath reports original array indices. Remove from the end of each
        // parent so earlier deletions cannot shift later matches out of place.
        const arrayMatches = new Map<unknown[], Set<number>>();
        for (const match of matches) {
          if (match.parent === null || match.parentProperty === null) continue;
          if (Array.isArray(match.parent) && typeof match.parentProperty === 'number') {
            const indices = arrayMatches.get(match.parent) ?? new Set<number>();
            indices.add(match.parentProperty);
            arrayMatches.set(match.parent, indices);
          } else {
            delete (match.parent as Record<string, unknown>)[String(match.parentProperty)];
          }
        }
        for (const [parent, indices] of arrayMatches) {
          for (const index of [...indices].sort((a, b) => b - a)) parent.splice(index, 1);
        }
      } else if (update !== undefined) {
        validateUpdate(update);
        for (const match of matches) {
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
    const existing = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isPlainObject(existing) && isPlainObject(value)) deepMerge(existing, value);
    else target[key] = value;
  }
}

// Reject forbidden keys in the entire update before touching the document.
// Arrays may contain object values even when the array itself replaces a node.
function validateUpdate(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`Overlay "update" contains forbidden key: ${key}`);
    }
    validateUpdate(child, seen);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}
