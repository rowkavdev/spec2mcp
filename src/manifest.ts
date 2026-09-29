/**
 * Manifest builder: walks every operation Forge resolved from the spec and
 * produces the operations.json manifest the generated MCP server runs from.
 * The manifest is the whole product of generation - the runtime that
 * interprets it is identical for every spec.
 */
import type { OpenAPIV3 } from 'openapi-types';
import { getAllOperationIds, resolveOperation, type ParameterInfo } from '../vendor/forge/index.js';
import { toToolName, dedupeNames, toEnvPrefix } from './naming.js';
import { buildAuthPlan, type AuthPlan } from './auth.js';

export type ToolArg = {
  /** Tool argument name (dotted for nested body fields, e.g. "origin.host"). */
  name: string;
  location: 'path' | 'query' | 'header' | 'body';
  /** For body args: path of API field names for nested body reconstruction. */
  apiFieldPath?: string[];
  required: boolean;
  schema: Record<string, unknown>;
};

export type ToolDef = {
  name: string;
  description: string;
  operationId: string;
  method: string;
  path: string;
  /** Preferred request content type, when the operation has a body. */
  contentType?: string;
  /** True when the request body is a top-level array - exposed as one "body" arg. */
  requestBodyIsArray?: boolean;
  args: ToolArg[];
  inputSchema: Record<string, unknown>;
};

export type Manifest = {
  generator: string;
  apiTitle: string;
  apiVersion: string;
  serverName: string;
  baseUrl: string;
  auth: AuthPlan;
  tools: ToolDef[];
};

export type ManifestOptions = {
  serverName?: string;
  baseUrl?: string;
};

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

function argSchema(p: ParameterInfo): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  const type = JSON_TYPES.has(p.type) ? p.type : 'string';
  schema.type = type;
  if (type === 'array') {
    const itemType = p.itemType && JSON_TYPES.has(p.itemType) && p.itemType !== 'array' ? p.itemType : 'string';
    const items: Record<string, unknown> = { type: itemType };
    if (p.itemEnumValues && p.itemEnumValues.length > 0) items.enum = p.itemEnumValues;
    schema.items = items;
  }
  if (type === 'object') schema.additionalProperties = true;
  if (p.enumValues && p.enumValues.length > 0) schema.enum = p.enumValues;
  if (p.default !== undefined) schema.default = p.default;
  if (p.description) schema.description = p.description;
  return schema;
}

function pickContentType(contentTypes: string[]): string | undefined {
  if (contentTypes.includes('application/json')) return 'application/json';
  return contentTypes[0];
}

export function buildManifest(doc: OpenAPIV3.Document, opts: ManifestOptions = {}): Manifest {
  const info = doc.info ?? ({ title: 'API', version: '0.0.0' } as OpenAPIV3.Document['info']);
  const apiTitle = info.title ?? 'API';
  const envPrefix = toEnvPrefix(opts.serverName ?? apiTitle);
  const auth = buildAuthPlan(doc, envPrefix);

  const firstServer = doc.servers?.[0]?.url ?? '';
  const baseUrl = opts.baseUrl ?? firstServer;

  const operationIds = getAllOperationIds();
  const toolNames = dedupeNames(operationIds.map(toToolName));
  const tools: ToolDef[] = [];

  operationIds.forEach((operationId, i) => {
    const op = resolveOperation(operationId);
    const toolName = toolNames[i];
    if (!op || !toolName) return;

    const args: ToolArg[] = [];
    for (const p of op.pathParams) {
      args.push({ name: p.name, location: 'path', required: true, schema: argSchema(p) });
    }
    for (const p of op.queryParams) {
      args.push({ name: p.name, location: 'query', required: p.required, schema: argSchema(p) });
    }
    for (const p of op.headerParams) {
      args.push({ name: p.name, location: 'header', required: p.required, schema: argSchema(p) });
    }

    const rootRequired = new Set(op.requestBodyRequired);
    if (op.requestBodyIsArray) {
      args.push({
        name: 'body',
        location: 'body',
        apiFieldPath: [],
        required: true,
        schema: { type: 'array', items: {}, description: op.requestBodyDescription ?? 'Request body (JSON array).' },
      });
    } else if (op.bodyParams.length > 0) {
      for (const p of op.bodyParams) {
        const argName = p.apiFieldPath.join('.');
        // A leaf is required at tool level when it is required within its
        // parent and its root field is required at body level. Nested optional
        // parents make this an approximation - documented in the README.
        const required = p.required && (p.apiFieldPath.length <= 1 ? rootRequired.has(p.apiFieldPath[0] ?? '') : rootRequired.has(p.apiFieldPath[0] ?? ''));
        args.push({ name: argName, location: 'body', apiFieldPath: p.apiFieldPath, required, schema: argSchema(p) });
      }
    } else if (op.hasRequestBody) {
      // Free-form or non-JSON body: one raw "body" argument.
      args.push({
        name: 'body',
        location: 'body',
        apiFieldPath: [],
        required: true,
        schema: { description: op.requestBodyDescription ?? 'Raw request body.' },
      });
    }

    const properties: Record<string, unknown> = {};
    const requiredArgs: string[] = [];
    for (const a of args) {
      properties[a.name] = a.schema;
      if (a.required) requiredArgs.push(a.name);
    }

    const description =
      op.description.split('\n')[0]?.trim() || `${op.method.toUpperCase()} ${op.path}`;

    const tool: ToolDef = {
      name: toolName,
      description,
      operationId,
      method: op.method.toUpperCase(),
      path: op.path,
      args,
      inputSchema: { type: 'object', properties, required: requiredArgs, additionalProperties: false },
    };
    const contentType = op.hasRequestBody ? pickContentType(op.requestContentTypes) : undefined;
    if (contentType) tool.contentType = contentType;
    if (op.requestBodyIsArray) tool.requestBodyIsArray = true;
    tools.push(tool);
  });

  return {
    generator: `spec2mcp`,
    apiTitle,
    apiVersion: info.version ?? '0.0.0',
    serverName: opts.serverName ?? envPrefix.toLowerCase().replace(/_/g, '-'),
    baseUrl,
    auth,
    tools,
  };
}
