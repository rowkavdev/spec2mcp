import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';

async function firstTool(doc: unknown) {
  const spec = doc as OpenAPIV3.Document;
  await init(spec);
  const tool = buildManifest(spec).tools[0];
  assert.ok(tool, 'the spec produced no tools');
  return tool;
}

// Each test below builds a manifest from a small spec and checks the tool arguments.
