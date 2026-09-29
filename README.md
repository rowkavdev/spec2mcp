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

To keep a generated project in sync while editing a local spec, run `spec2mcp generate openapi.json --out ./petstore-mcp --watch`. For a URL, `--watch` polls every 30 seconds by default; use `--poll-interval 60` to change that interval in seconds. Watch mode regenerates only when the spec content changes, retries failed generations, and prints errors to stderr while continuing to watch. It replaces the generated output directory on regeneration, so keep hand edits elsewhere. Stop with Ctrl+C. `serve` does not support `--watch`.

Or skip the project and serve a spec directly over stdio:

```bash
npx spec2mcp serve openapi.json
```

Streamable HTTP is available in both modes, with SSE support and separate MCP sessions per client:

```bash
npx spec2mcp serve openapi.json --transport http --port 3000
# or, inside a generated project:
PORT=3000 npm run start:http
```

Point an MCP Streamable HTTP client at `http://127.0.0.1:3000/mcp`. The server listens only on loopback, validates Host and Origin, and has **no client authentication**. Do not expose it on a public network; API credentials in the server environment are shared across clients. The default transport remains stdio.

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
- `multipart/form-data` bodies become one argument per form field, sent as a real multipart request. File fields take `{ "contentBase64": "...", "filename": "...", "mimeType": "..." }` (only `contentBase64` is required); object and array fields are JSON-serialised into their form field.
- Non-JSON responses map to MCP content types: images come back as image content, audio as audio content, and other binary types (PDF, zip, octet-stream) as embedded blob resources. Text and JSON responses come back as text.
- Large responses are capped so one call cannot flood the conversation: text is truncated at 50,000 characters and binary payloads at 4 MiB, each with a notice saying so. Override with `SPEC2MCP_MAX_RESPONSE_CHARS` and `SPEC2MCP_MAX_BINARY_BYTES`.
- Non-2xx responses come back as tool errors with the status and response body; missing required arguments fail before any request is made.
- Real specs reuse names across locations (Spotify has `uris` in both query and body; Kubernetes has a `{path}` template and a `path` query param). The later argument is renamed with its location (`uris_body`) and still sent on the wire under the API's own name.

## Select tools and save project settings

Use repeatable `--include` and `--exclude` selectors with either an exact OpenAPI tag (`tag:catalog`) or an operationId glob (`operation:list*`). An unprefixed selector matches either an exact tag or an operationId glob. `*` matches any sequence and `?` one character; matching is case-sensitive. Includes are combined with OR, and excludes take priority. With no includes, all operations are eligible.

```bash
spec2mcp generate openapi.yaml --include 'tag:catalog' --exclude 'operation:delete*'
```

For reusable settings, put `spec2mcp.config.json` in the current directory (or pass `--config path/to/settings.json`):

```json
{
  "name": "petstore",
  "baseUrl": "https://api.example.com/v1",
  "include": ["tag:catalog"],
  "exclude": ["operation:delete*"]
}
```

CLI flags override the corresponding config keys; repeat each flag to supply multiple selectors. Generation writes the effective settings to the generated project's `spec2mcp.config.json`. Its server reads that file at startup and can narrow its generated tools or override name and base URL without rebuilding. To expose additional operations, regenerate from the original spec. Environment `<PREFIX>_BASE_URL` still overrides the configured base URL at call time. `serve` reads the working directory's config too.

## Curate tools with overlays

Rename, re-describe or remove operations before generation with [OpenAPI Overlays](https://spec.openapis.org/overlay/latest.html) (v1.0.0). Pass `--overlay` per file, repeatable, applied in order after any earlier files:

```bash
spec2mcp generate openapi.yaml --overlay curate.yaml --out ./my-mcp
```

```yaml
overlay: 1.0.0
info:
  title: Curate the tools
  version: 1.0.0
actions:
  - target: $.paths.*[?(@.operationId=='getPet')]
    update:
      operationId: fetchPet          # renames the tool to fetch_pet
  - target: $.paths.*[?(@.operationId=='deletePet')]
    remove: true                      # no tool is generated for it
  - target: $.paths.*[?(@.operationId=='listPets')]
    update:
      description: List every pet currently in the store.
```

Each action's `target` is a JSONPath evaluated against the spec; `update` deep-merges into every matched node and `remove: true` deletes it. A target that matches nothing fails the run, so a stale operationId in your overlay is caught instead of silently ignored. Overlays apply before tool-name derivation and filtering, so renamed operations flow into tool names and `--include` selectors see the overlaid ids. Forge-specific `x-forge-commands` overlay keys are ignored - they belong to Forge's cf CLI pipeline, not MCP generation.

## Auth

Auth comes from the spec's `securitySchemes`; the server reads secrets from environment variables at call time. Nothing secret is ever written into generated files.

| Scheme | Behaviour |
| --- | --- |
| HTTP bearer | `Authorization: Bearer $ENV_VAR` |
| HTTP basic | `$ENV_VAR` holds `user:password`, sent as Basic |
| apiKey (header or query) | `$ENV_VAR` sent as the named header/query param |
| OAuth2 / OIDC | treat the env var as a pre-minted bearer token |

Each tool uses its operation-level `security` when present, otherwise the root requirement. An explicit `security: []` sends no credentials. The first fully mapped OR alternative is selected when available (its schemes are combined as AND); a missing or unsupported scheme produces a generation-time warning and uses the sole supported scheme as a fallback if one exists, otherwise continues without that scheme.

Env var names are derived from the API title and scheme name, e.g. `PET_STORE_BEARER_AUTH`. The generated `.env.example` lists them all. `<PREFIX>_BASE_URL` overrides the spec's server URL, so one generated server can point at staging or prod without regenerating.

## vs Cloudflare Code Mode

Cloudflare's own [Code Mode](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-openapi-mcp-server/) (`openApiMcpServer()`) exposes an API through a hosted search/execute proxy running on Cloudflare. spec2mcp is the other shape: it generates a standalone server project from the spec - a file tree you own, run where you want, and check into git. No hosted dependency. The two complement each other, which is also why this transformer fits Forge's plugin model.

## Scale and verified APIs

Verified against two of the biggest public specs (run `node examples/live-github.mjs` to reproduce the second):

- **GitHub's official REST API spec** - 1,231 tools generated; the example then npm-installs the project, connects the official MCP client over stdio, and calls `repos_get` against live api.github.com.
- **Cloudflare's own public API spec** (2,185 paths, ~26 MB) - 3,469 tools generated in about 9 seconds, with the `api_token` bearer scheme mapped to an env var.

CI also runs a compat matrix over pinned snapshots of four large public APIs, verifying generation, exact tool counts and tool shape (`test/compat.test.ts`). Snapshots live in `test/fixtures/compat/` and are refreshed from the live sources with `npm run compat:refresh`.

| API | OpenAPI | Tools | Notes |
| --- | --- | --- | --- |
| [Stripe](https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json) | 3.0.0 | 612 | Basic-auth scheme maps to `STRIPE_API_BASIC_AUTH` |
| [Kubernetes (core/v1)](https://raw.githubusercontent.com/kubernetes/kubernetes/master/api/openapi-spec/v3/api__v1_openapi.json) | 3.0.0 | 236 | No server URL in the spec - set `KUBERNETES_BASE_URL` |
| [Spotify Web API](https://developer.spotify.com/reference/web-api/open-api-schema.yaml) | 3.0.3 | 96 | References an external file (`../policies.yaml`), bundled at load |
| [Vercel](https://openapi.vercel.sh/) | 3.0.3 | 431 | Auth is declared per-operation; each tool picks up its operation-level schemes |

## OpenAPI 3.1

3.1 specs work: JSON Schema 2020-12 type unions (`type: ["string", "null"]`) are collapsed to a single type at load, a multi-type union becomes an `anyOf` the resolver understands, and a webhook-only document (no `paths`) is valid input. Two 3.1-specific fields are handled explicitly:

- **`webhooks`** - a webhook is an event the API sends to *your* server, so webhooks are never tools. They are recorded in `operations.json` and listed in the generated README instead of being silently dropped.
- **`jsonSchemaDialect`** - recorded in `operations.json`; a non-default dialect is flagged in the generated README and CLI output, since tool argument schemas are approximated as standard JSON Schema.

## Current limitations

Honest list, all roadmap items:

- Multi-type unions (`type: [string, integer]`) degrade to a string argument; single-type-plus-null collapses cleanly
- Nested-body `required` flags are approximated when an intermediate object is optional
- Raw `application/octet-stream` request bodies pass through as a raw `body` string argument (multipart uploads are handled per field)
- Forge currently indexes GET/POST/PUT/PATCH/DELETE operations
- `head`/`options`/`trace` operations are not exposed (Forge limitation)
- Overlay actions support `target` + `update`/`remove` only (the curation subset of the Overlay spec)

## Roadmap

- Support configurable choices between multiple security OR alternatives
- Upstream the transformer to [cloudflare/forge](https://github.com/cloudflare/forge) as their MCP target
- Publish to npm (the badges above go live with the first release)

## Development

```bash
npm install
npm run typecheck   # strict tsc over src + vendored forge
npm run build       # esbuild bundle -> dist/cli.mjs
npm test            # node:test unit + e2e (drives MCP sessions over stdio and HTTP)
```

Layout: `src/` (CLI, loader, manifest builder, transformer), `runtime/server.mjs` (the file copied into generated projects), `vendor/forge/` (pinned `@cloudflare/forge`, see its PINNED.md), `test/` (fixture specs + an e2e test that boots a generated server against a mock API).

## License

MIT. Vendored Forge code is Apache-2.0, copyright Cloudflare, Inc. (see `vendor/forge/LICENSE`).
