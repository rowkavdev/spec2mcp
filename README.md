# spec2mcp

[![CI](https://github.com/rowkavdev/spec2mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rowkavdev/spec2mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/spec2mcp)](https://www.npmjs.com/package/spec2mcp)
[![npm downloads/week](https://img.shields.io/npm/dw/spec2mcp)](https://www.npmjs.com/package/spec2mcp)
[![npm downloads/month](https://img.shields.io/npm/dm/spec2mcp)](https://www.npmjs.com/package/spec2mcp)
[![yearly downloads](https://img.shields.io/npm/dy/spec2mcp)](https://www.npmjs.com/package/spec2mcp)

spec2mcp turns an OpenAPI 3.x or Swagger 2.0 spec into an MCP server. Give it a JSON or YAML file or URL; it resolves the spec through [Cloudflare Forge](https://github.com/cloudflare/forge) and maps supported API operations to MCP tools. Generate a standalone Node project to run and edit yourself, or serve the spec directly. No hosted proxy is required.

## Status

Early development. The package name is `spec2mcp`; npm publication is in progress, so the npm badges and `npx` command below may not work until the first release. The generator currently indexes GET, POST, PUT, PATCH and DELETE operations. Review generated tools and auth warnings before using credentials. See [compatibility and limits](docs/guide.md#compatibility-and-limits).

## Quickstart

Once published (Node.js 22+):

```bash
npx spec2mcp generate ./openapi.yaml --out ./my-api-mcp
cd my-api-mcp
npm install
# Set the credentials named in .env.example in your MCP client's environment.
npm start
```

Until publication, build from this repository and replace `npx spec2mcp` with `node /absolute/path/to/spec2mcp/dist/cli.mjs`:

```bash
npm ci && npm run build
node dist/cli.mjs generate test/fixtures/petstore.yaml --out /tmp/petstore-mcp
```

`npm start` speaks MCP over stdio, so start it from an MCP client, not as a text REPL. For example, add a generated server to Claude Desktop's MCP configuration:

```json
{
  "mcpServers": {
    "my-api": {
      "command": "node",
      "args": ["/absolute/path/to/my-api-mcp/server.mjs"],
      "env": { "MY_API_BEARER_AUTH": "your token" }
    }
  }
}
```

That env var is an example, not a fixed name. The generated `.env.example` lists the names for your spec; export them or set them in the MCP client. The server does not load `.env` automatically. If your spec lacks a server URL, set `<PREFIX>_BASE_URL` or pass `--base-url` when generating.

You can also run without creating a project, or use local Streamable HTTP:

```bash
npx spec2mcp serve ./openapi.yaml
npx spec2mcp serve ./openapi.yaml --transport http --port 3000
# In a generated project: PORT=3000 npm run start:http
```

HTTP clients connect to `http://127.0.0.1:3000/mcp`. The endpoint is loopback-only and has **no MCP-client authentication**; do not expose it publicly or share a proxy to it. Clients use the API credentials in the server process. For flags, filters, watch mode, HTTP sessions, and configuration, see the [full guide](docs/guide.md).

## Why generate a project?

OpenAPI-to-MCP is not new. Cloudflare's [Code Mode](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-openapi-mcp-server/) is one approach, using a Cloudflare-hosted search/execute proxy. spec2mcp makes a different tradeoff: it writes `server.mjs`, `operations.json`, configuration, startup instructions and auth templates into a project you own. You can inspect the HTTP mapping, select tools, version the result, and run it wherever Node 22+ runs. The generated server depends only on `@modelcontextprotocol/sdk` at runtime. Forge is used during generation, not required by the generated project.

```
OpenAPI spec -> bundled $refs -> Forge resolver -> spec2mcp transformer -> standalone MCP project
```

Missing operation IDs are synthesized; tool names derive from operation IDs (`listPets` becomes `list_pets`). Path, query, header and JSON-body fields become arguments. Multipart uploads accept base64 file fields, and image/audio/binary responses map to MCP content types. Declared JSON success schemas can produce MCP `outputSchema` and `structuredContent`, validated against the schema before attaching so a drifted API response falls back to text-only instead of breaking the client; large or absent schemas stay text-only. Response caps keep large calls from overwhelming clients. [Tool behavior and limits](docs/guide.md#generated-project) has the details.

## Select operations and configure auth

```bash
npx spec2mcp generate api.yaml --include 'tag:catalog' --exclude 'operation:delete*'
```

Selectors match exact tags or case-sensitive operation ID globs. `--include` and `--exclude` repeat; excludes win. The current directory's `spec2mcp.config.json` can hold `name`, `baseUrl`, `envPrefix`, `overlays`, `include`, and `exclude`, with CLI flags overriding each key.

To curate tools before generation, pass OpenAPI Overlay files with `--overlay` (repeatable, applied in order). Each action targets spec nodes by JSONPath, deep-merges an `update`, or deletes the node with `remove: true`; an unmatched target fails the run instead of being silently ignored. Renamed operations flow into tool names. Set a fixed auth env-var prefix with `--env-prefix` (overlapping words collapse: `CLOUDFLARE_API` + `API_TOKEN` becomes `CLOUDFLARE_API_TOKEN`). Generated projects save their effective settings and can narrow existing tools at startup; adding back tools excluded during generation requires regeneration. `--watch` regenerates when the source spec changes and **replaces the generated directory**, so keep hand edits elsewhere. [Configuration reference](docs/guide.md#cli-reference).

Auth comes from the spec's security schemes. The generated `.env.example` names each needed variable, such as `PET_STORE_BEARER_AUTH` for a `Pet Store` bearer scheme. HTTP bearer/basic, header/query API keys, and pre-minted OAuth/OIDC bearer tokens are mapped; the server does not perform OAuth login or refresh. An unset variable means the request proceeds without it, possibly returning a 401. [Auth mapping and security caveats](docs/guide.md#authentication-and-environment).

## Verified APIs

| API spec | Result | Verification scope |
| --- | --- | --- |
| GitHub REST | 1,231 generated tools | Project installed; MCP stdio client invoked `repos_get` against live `api.github.com`. Reproduce with `node examples/live-github.mjs`. |
| Cloudflare API | 3,469 generated tools | Generation from its public spec (2,185 paths, about 26 MB); `api_token` bearer scheme mapped. |
| Stripe, Kubernetes (core/v1), Spotify, Vercel | 612 / 236 / 96 / 431 tools | Pinned snapshots verified in CI by the compat matrix (`test/compat.test.ts`), including tool shape and full project emission. Refresh from live sources with `npm run compat:refresh`. |
| Kubernetes aggregated Swagger 2.0 | 1,190 tools | 2.0 spec converted to 3.x in memory at load; pinned fixture test. |
| Discord | 246 tools | Generation from the official spec; bot token and OAuth2 schemes mapped. |

Those counts reflect the specs tested, not a guarantee that all later versions generate identical tools or that every endpoint was called. OpenAPI 3.1 input is covered by a fixture, but webhooks are not inbound MCP tools and some 3.1 schema features may not translate exactly. Swagger 2.0 inputs convert at load; 2.0 specs with external `$ref`s relative to the spec's own location are unsupported (the converted document exists only in memory). [Compatibility table](docs/guide.md#compatibility-and-limits).

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`src/` holds the generator, `runtime/server.mjs` is copied into generated projects, `test/` covers manifests and MCP sessions, and `vendor/forge/` contains the pinned Forge source. [Full guide](docs/guide.md) · [Forge pin](vendor/forge/PINNED.md).

MIT licensed. Vendored Forge code is Apache-2.0, copyright Cloudflare, Inc.; see `vendor/forge/LICENSE`.
