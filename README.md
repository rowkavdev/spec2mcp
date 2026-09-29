# spec2mcp

[![CI](https://github.com/rowkavdev/spec2mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rowkavdev/spec2mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/spec2mcp)](https://www.npmjs.com/package/spec2mcp)
[![npm downloads/week](https://img.shields.io/npm/dw/spec2mcp)](https://www.npmjs.com/package/spec2mcp)
[![npm downloads/month](https://img.shields.io/npm/dm/spec2mcp)](https://www.npmjs.com/package/spec2mcp)
[![yearly downloads](https://img.shields.io/npm/dy/spec2mcp)](https://www.npmjs.com/package/spec2mcp)

spec2mcp turns any OpenAPI 3.x spec into a working MCP server with one command. Every operation in the spec becomes a tool that Claude, Cursor, or any other MCP client can call, with argument schemas, required-field checks, and auth pulled from the spec itself.

It is built as a transformer for [Forge](https://github.com/cloudflare/forge), the generation pipeline Cloudflare open-sourced for their `cf` CLI: the spec goes through Forge's resolver and plugin lifecycle, and spec2mcp's transformer emits the server.

## What you get

A standalone MCP server project that you own. Not a hosted proxy, not a SaaS: real files in a directory, runnable anywhere Node 22+ runs, editable like any other project.

```bash
npx spec2mcp generate openapi.json --out ./petstore-mcp
cd petstore-mcp && npm install && npm start
```

Or skip the project and serve a spec directly over stdio:

```bash
npx spec2mcp serve openapi.json
```

Two lines in your Claude Desktop config and every endpoint in the spec is a tool:

```json
{
  "mcpServers": {
    "petstore": {
      "command": "npx",
      "args": ["-y", "spec2mcp", "serve", "/path/to/openapi.json"],
      "env": { "PET_STORE_BEARER_AUTH": "your token" }
    }
  }
}
```

## How it works

```
openapi.json ──► bundle external $refs ──► Forge resolver ──► spec2mcp transformer ──► MCP server project
                     (json-schema-ref-parser)   (operations,     (operations.json        (server.mjs +
                                                 parameters,      manifest)               one npm dep)
                                                 bodies, types)
```

1. **Load.** File path or URL, JSON or YAML. External `$ref`s are bundled in. Missing `operationId`s are synthesised from method + path (`GET /pets/{petId}` becomes `get_pets_petid`), and duplicates are uniquified - no operation is silently dropped.
2. **Resolve.** The spec goes through Forge's OpenAPI resolver, the same operation/parameter model behind Cloudflare's `cf` CLI (3,000+ operations). spec2mcp vendors Forge pinned to a commit because `@cloudflare/forge` is not on npm yet; the vendored copy is Apache-2.0 and swaps for the npm package when it ships.
3. **Emit.** A Forge transformer writes the project: `operations.json` (the tool manifest), `server.mjs` (a generic runtime, identical for every spec), `package.json`, a README with a tool table, and a `.env.example` naming every credential the server expects.

The generated server's only dependency is `@modelcontextprotocol/sdk`.

## Tools and arguments

- One MCP tool per operation, named from the `operationId` in MCP-safe snake_case (`listPets` -> `list_pets`).
- Path, query and header parameters become typed tool arguments with descriptions, enums and defaults from the spec.
- JSON request bodies are flattened into arguments per field (`address.street`) and reconstructed into the nested body on the call. Array and free-form bodies become a single `body` argument.
- Non-2xx responses come back as tool errors with the status and response body; missing required arguments fail before any request is made.

## Auth

Auth comes from the spec's `securitySchemes`; the server reads secrets from environment variables at call time. Nothing secret is ever written into generated files.

| Scheme | Behaviour |
| --- | --- |
| HTTP bearer | `Authorization: Bearer $ENV_VAR` |
| HTTP basic | `$ENV_VAR` holds `user:password`, sent as Basic |
| apiKey (header or query) | `$ENV_VAR` sent as the named header/query param |
| OAuth2 / OIDC | treat the env var as a pre-minted bearer token |

Env var names are derived from the API title and scheme name, e.g. `PET_STORE_BEARER_AUTH`. The generated `.env.example` lists them all. `<PREFIX>_BASE_URL` overrides the spec's server URL, so one generated server can point at staging or prod without regenerating.

## vs Cloudflare Code Mode

Cloudflare's own [Code Mode](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-openapi-mcp-server/) (`openApiMcpServer()`) exposes an API through a hosted search/execute proxy running on Cloudflare. spec2mcp is the other shape: it generates a standalone server project from the spec - a file tree you own, run where you want, and check into git. No hosted dependency. The two complement each other, which is also why this transformer fits Forge's plugin model.

## Scale

Verified against two of the biggest public specs (run `node examples/live-github.mjs` to reproduce the second):

- **GitHub's official REST API spec** - 1,231 tools generated; the example then npm-installs the project, connects the official MCP client over stdio, and calls `repos_get` against live api.github.com.
- **Cloudflare's own public API spec** (2,185 paths, ~26 MB) - 3,469 tools generated in about 9 seconds, with the `api_token` bearer scheme mapped to an env var.

## Current limitations

Honest list, all roadmap items:

- stdio transport only (no streamable HTTP yet)
- The first root-level `security` requirement applies to all tools; per-operation security overrides are not read yet
- Nested-body `required` flags are approximated when an intermediate object is optional
- Non-JSON request bodies (multipart, octet-stream) pass through as a raw `body` string argument
- Forge currently indexes GET/POST/PUT/PATCH/DELETE operations
- `head`/`options`/`trace` operations are not exposed (Forge limitation)

## Roadmap

- Streamable HTTP transport for the generated server
- Per-operation security and multiple auth requirements
- Overlay support (rename/curate tools via Forge's JSONPath overlays)
- Upstream the transformer to [cloudflare/forge](https://github.com/cloudflare/forge) as their MCP target
- Publish to npm (the badges above go live with the first release)

## Development

```bash
npm install
npm run typecheck   # strict tsc over src + vendored forge
npm run build       # esbuild bundle -> dist/cli.mjs
npm test            # node:test unit + e2e (drives a real MCP session over stdio)
```

Layout: `src/` (CLI, loader, manifest builder, transformer), `runtime/server.mjs` (the file copied into generated projects), `vendor/forge/` (pinned `@cloudflare/forge`, see its PINNED.md), `test/` (fixture specs + an e2e test that boots a generated server against a mock API).

## License

MIT. Vendored Forge code is Apache-2.0, copyright Cloudflare, Inc. (see `vendor/forge/LICENSE`).
