# spec2mcp guide

spec2mcp turns an OpenAPI 3.x document into an MCP server. `generate` writes a standalone Node project you can inspect, edit and run yourself; `serve` runs the same tool model directly from a spec. The generator uses Cloudflare Forge's OpenAPI resolver and transformer pipeline. It does not require Cloudflare hosting.

## Install

Node.js 22 or newer is required. Once `spec2mcp` is published on npm, use `npx spec2mcp ...` or install it globally with `npm install -g spec2mcp`. Until then, run from a checkout:

```bash
npm ci
npm run build
node dist/cli.mjs --help
```

The examples below use `spec2mcp` as the command. From a checkout, substitute `node /absolute/path/to/spec2mcp/dist/cli.mjs`. A generated project's runtime needs its own `npm install` (or `npm ci` if you commit its lockfile).

## Quickstart

```bash
spec2mcp generate ./openapi.yaml --out ./my-api-mcp
cd my-api-mcp
npm install
# Set any variables listed in .env.example in the environment of the MCP process.
npm start
```

The spec can be a local JSON/YAML file or an HTTP(S) URL. `npm start` runs the generated server over stdio: connect it to an MCP client rather than expecting an interactive shell. For example, add this entry to a Claude Desktop MCP configuration, changing the path and environment for your project:

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

The `env` key and its variable name are illustrative. Check **your** generated `.env.example`; each spec's title and security schemes determine its names. A `.env` file is only a template for you to load or export; the server does not load it automatically.

To skip generation, run `spec2mcp serve ./openapi.yaml` as your MCP client's command. For a local Streamable HTTP endpoint instead:

```bash
spec2mcp serve ./openapi.yaml --transport http --port 3000
# or, from inside a generated project:
PORT=3000 npm run start:http
```

Connect a Streamable HTTP MCP client to `http://127.0.0.1:3000/mcp`. Both modes use stdio by default. HTTP binds to loopback, checks Host and Origin, supports GET/SSE and separate client sessions, but **does not authenticate MCP clients**. Do not publish the endpoint or put it behind an unauthenticated proxy: all clients share the API credentials in the process environment.

## CLI reference

```
spec2mcp generate <spec> [options]
spec2mcp serve <spec> [options]
spec2mcp <spec> [options]          # shorthand for generate
```

| Flag | Applies to | Effect |
| --- | --- | --- |
| `-o, --out <dir>` | generate | Output directory; defaults to `./<name>-mcp`. Generation overwrites the files it owns there, including on a watch update, and preserves everything else (including `node_modules`, so installed dependencies survive regeneration). Do not keep hand edits to generated files there while regenerating. |
| `--name <name>` | both | MCP server name; otherwise derived from the spec title. Also changes the prefix of generated auth and base-URL variable names. |
| `--base-url <url>` | both | Override the first URL in the spec's root `servers` array. If neither is set, provide `<PREFIX>_BASE_URL` to the running server. |
| `--env-prefix <prefix>` | both | Fixed prefix for generated auth and base-URL variable names, instead of deriving it from the spec title. Must be a valid variable name: letters, digits and underscores, not starting with a digit. Overlapping words collapse (`CLOUDFLARE_API` + `API_TOKEN` -> `CLOUDFLARE_API_TOKEN`). |
| `--overlay <file>` | both | Repeatable: apply OpenAPI Overlay v1.0.0 files, in order, before generation. Each action targets nodes by JSONPath, deep-merges `update`, or removes the node with `remove: true`; an unmatched target fails the run. |
| `--include <selector>` | both | Repeatable: generate or serve matching operations only. |
| `--exclude <selector>` | both | Repeatable: omit matching operations, even if included. |
| `--config <file>` | both | Read JSON settings from this file. Without the flag, use `./spec2mcp.config.json` if present. |
| `--watch` | generate | Generate initially and regenerate on local file changes or URL changes; errors print to stderr and are retried. Stop with Ctrl+C. |
| `--poll-interval <seconds>` | generate with `--watch` and HTTP(S) URL | URL polling interval from 1 to 2147483 seconds (the timer limit); default 30 seconds. Not accepted with local files. |
| `--transport <stdio\|http>` | serve | Default stdio; HTTP is local Streamable HTTP. A generated project's transport uses `npm start` or `npm run start:http` instead. |
| `--port <number>` | serve with `--transport http` | HTTP port, default 3000; integer 0-65535. Port 0 asks the OS for an available port. For generated projects use `PORT`, default 3000. |
| `-h, --help` | both | Show CLI help. |
| `-v, --version` | both | Show version. |

`<spec>` is an OpenAPI 3.x or Swagger 2.0 JSON or YAML path/URL. Swagger 2.0 documents are converted to 3.x in memory at load (swagger2openapi, generation-time only), with `host`/`basePath`/`schemes` becoming the server URL and `securityDefinitions` becoming security schemes; 2.0 external `$ref`s are bundled from the spec's own location before conversion. The loader bundles external `$ref`s and synthesizes missing operation IDs. `--watch` is not supported by `serve`; URL watching polls the source, while local watching observes the file's parent directory. Regeneration occurs only if the source bytes changed (or a prior generation failed). External referenced documents are bundled when generation runs, but changing an external file alone does not trigger a local watch. The URL watcher fetches the source every interval, so use a rate appropriate to that host.

Selectors are case-sensitive. `tag:catalog` matches an exact OpenAPI tag; `operation:list*` matches an `operationId` glob (`*` any sequence, `?` one character). An unprefixed selector matches either an exact tag or an operation ID glob. Includes are OR-ed, then excludes win. With no includes, all indexed operations are eligible:

```bash
spec2mcp generate api.yaml --include 'tag:catalog' --include 'operation:get*' --exclude 'operation:delete*'
```

A config file can hold reusable settings:

```json
{
  "name": "my-api",
  "baseUrl": "https://api.example.com/v1",
  "envPrefix": "MYAPI",
  "overlays": ["curate.yaml"],
  "include": ["tag:catalog"],
  "exclude": ["operation:delete*"]
}
```

Only `name`, `baseUrl`, `envPrefix`, `overlays`, `include`, and `exclude` are config keys. Generation writes the effective `name`, `baseUrl`, `envPrefix`, `include`, and `exclude` into the generated `spec2mcp.config.json`, so regenerating from that file reproduces the same server and credential variables; `overlays` are not saved (their paths are relative to where you ran the CLI), so pass `--overlay` again when regenerating from an emitted config. CLI flags override corresponding keys; repeated selectors on the CLI replace that key's config array rather than appending to it. `--out`, `--watch`, `--poll-interval`, `--transport`, and `--port` are flags, not config keys. `serve` reads config in the current working directory or via `--config`. A generated server reads its sibling `spec2mcp.config.json` at startup; changing its name/base URL or narrowing its *already generated* tools needs no regeneration. An operation excluded at generation does not exist in `operations.json` and cannot be restored by editing the generated config: regenerate from the spec. `<PREFIX>_BASE_URL` takes precedence over the config base URL at call time.

## Generated project

| File | Purpose |
| --- | --- |
| `server.mjs` | Generic MCP-to-HTTP runtime; the same source is used for each generated API. |
| `operations.json` | Tool manifest, including names, arguments, auth selection, request/response metadata, and available output schemas. |
| `package.json` | Private Node 22+ package with `start` and `start:http`; its only runtime dependency is `@modelcontextprotocol/sdk`. |
| `spec2mcp.config.json` | Effective name, base URL, and include/exclude filters, read on startup. |
| `.env.example` | Required variable names and placeholders, **not** loaded by the runtime. Never commit real secrets. |
| `README.md` | API-specific startup steps, tool table, and auth hints. |
| `.gitignore` | Ignores `node_modules/` and `.env`. |

Each indexed GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD or TRACE operation becomes a tool with an MCP-safe name derived from its `operationId` (for example, `listPets` becomes `list_pets`; duplicate names get suffixes). Path, query, header and request-body fields become typed arguments, with required-field checks before making an HTTP request. JSON object body fields may appear as dotted arguments such as `address.street` and are rebuilt into an object for the API; array and free-form bodies use a single `body` argument. Nested required fields under an optional parent can be approximated. Multipart file arguments use `{ "contentBase64": "...", "filename": "...", "mimeType": "..." }`; only `contentBase64` is required. Non-JSON success bodies become image, audio, or embedded resource content according to MIME type.

If a successful JSON response declares a usable schema, the tool may advertise an MCP `outputSchema` and return `structuredContent` alongside text. Candidate structured content is validated against the advertised schema before attaching; a drifted response logs a warning and returns text-only, since MCP SDK clients hard-error results that fail the schema. Top-level arrays/primitives are wrapped as `{ "result": ... }`. Schemas over 4,096 serialized bytes, absent schemas, and responses not parseable as JSON remain text-only; cyclic references are truncated when the schema is prepared. Text is limited to 50,000 characters by default (`SPEC2MCP_MAX_RESPONSE_CHARS`); binary payloads over 4 MiB are omitted with a notice (`SPEC2MCP_MAX_BINARY_BYTES`). These are process environment variables with positive integer byte/character limits. Non-2xx responses are tool errors with HTTP status and a bounded body. An empty success body is reported as text.

Typeless object idioms: a schema of `{ properties: ... }` without an explicit `type` is treated as an object schema (advertised directly, not wrapped). Strict JSON Schema 2020-12 - the 3.1 dialect - would also admit scalar roots there, since `properties` only constrains objects; but the 3.0 idiom and real-world specs mean an object. This is a deliberate, recorded decision (#111), not an accident: declare `type: object` (or a type union / `oneOf` including a non-object branch) if the API genuinely returns non-object roots, and the tool wraps them under `result` instead.

## Authentication and environment

The generator maps supported `components.securitySchemes` to environment variable names: `<API_TITLE_OR_NAME_PREFIX>_<SCHEME_NAME>`, uppercased with non-alphanumeric characters turned into underscores. For a `Pet Store` title and `bearerAuth` scheme, this is `PET_STORE_BEARER_AUTH`; specifying `--name` changes the prefix. Read `.env.example` for the exact variables emitted for the operations you generated.

| OpenAPI scheme | Environment value | Request mapping |
| --- | --- | --- |
| HTTP bearer | Token only | `Authorization: Bearer <token>` |
| HTTP basic | `username:password` | Base64-encoded Basic authorization |
| `apiKey` in header | API key | Scheme's named header |
| `apiKey` in query | API key | Scheme's named query parameter |
| OAuth2 / OpenID Connect | Already minted access token | Bearer authorization; no OAuth login/refresh flow |

The process also accepts `<PREFIX>_BASE_URL` to override the API base URL. Set variables in the actual server environment, for example via your MCP client's `env` configuration. No secret values are generated or stored by spec2mcp. Unset auth variables produce a startup warning and calls proceed without them, so the API may return 401.

An operation's `security` takes priority over root `security`; `security: []` means anonymous. Each object in a security array is an OR alternative, with its keys combined as AND. Every fully mapped alternative is preserved in spec order; at call time the runtime uses the first alternative whose credentials are all configured, falling back to the first alternative when none is fully configured. Missing/unsupported schemes cause generation warnings; if just one supported scheme exists it may be used as a fallback, otherwise the unsupported part is skipped. Check the warnings and actual API behavior before using a security-sensitive operation. Multiple bearer-style schemes needing the same `Authorization` header are not independently satisfiable in one request.

## Compatibility and limits

| Input or behavior | Status |
| --- | --- |
| OpenAPI 3.0.x and 3.1.x JSON/YAML | Supported as input; 3.1 fixture covered by tests. Some 3.1 schema vocabulary may not translate exactly to MCP JSON Schema. |
| Swagger/OpenAPI 2.0 | Converted to 3.x in memory at load; Kubernetes' full aggregated swagger.json (1,202 tools) is a pinned test. External `$ref`s relative to the 2.0 spec's location are unsupported. |
| Local file and HTTP(S) spec URL; external `$ref` | Supported; external refs are bundled at generation/load time. |
| GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD, TRACE | Indexed by the pinned Forge resolver. |
| `webhooks` (OpenAPI 3.1), callbacks | Not emitted as tools: generation covers callable paths, not inbound event receivers. |
| JSON request/response schemas | Tool inputs; bounded `outputSchema` for declared JSON success schemas, with the limits above. |
| Multipart forms, binary responses | Multipart form fields and base64 file inputs; binary response content maps to MCP media/resource types with size caps. |
| Query, header and cookie parameter values | Serialized by their declared `style` and `explode`. A `null` value (from `nullable: true`) is left off the request, and `null` items or properties inside an array or object are dropped; an array or object left empty sends nothing. A query array with `style: deepObject` (Stripe's `expand`) is sent as `name[]=a&name[]=b`, and `explode: false` is ignored for it. Parameters declared with a JSON `content` media type are sent as JSON, where `null` stays `null`. |
| Authentication | Environment-based HTTP bearer/basic, header/query API keys, pre-minted OAuth/OIDC bearer token; no token acquisition or refresh. |
| stdio and Streamable HTTP | Supported; HTTP is loopback-only and has no MCP-client authentication. |
| Large specs | GitHub REST (1,231 tools, live-called) and Cloudflare API (3,469 tools, ~9s) verified during development; Stripe, Kubernetes, Spotify, Vercel, Discord and Slack are pinned CI compat fixtures (612/248/96/435/246/174 tools, exact counts and tool shape asserted; Slack's snapshot is Swagger 2.0, pinning the conversion path end to end). Client-side listing size/performance still depends on the MCP client. |

Live-call coverage beyond GitHub is not asserted, so do not assume every endpoint or security flow was exercised. Generated code is inspectable and should be reviewed before giving it credentials. Cloudflare [Code Mode](https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-openapi-mcp-server/) is another OpenAPI-to-MCP approach; spec2mcp's difference is the standalone project that you own and deploy.

## Develop

```bash
npm ci
npm run typecheck
npm run build
npm test
```

The generator lives in `src/`, its copied runtime in `runtime/server.mjs`, and the pinned Forge source and attribution in `vendor/forge/`. See `vendor/forge/PINNED.md` for its upstream revision and license.
