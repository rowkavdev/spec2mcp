# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

Everything below is unreleased; it becomes the 0.1.0 release notes.

### Added

- **Parameter wire forms.** A `null` query, header or cookie value is left off
  the request instead of being sent as the text `null`, and a query array with
  `style: deepObject` is sent as `name[]=a&name[]=b` (what Stripe's `expand`
  expects).
- **deepObject form bodies.** Form-encoded request bodies whose fields declare
  `style: deepObject` (Stripe's whole write API) are sent as `name[key]=v`,
  `name[]=v` and `name[0][key]=v`. Before, every such call failed with
  "Unsupported form encoding", even when the field was not sent.
- **Generator MVP.** `spec2mcp generate` turns an OpenAPI 3.x spec (JSON or
  YAML, file or URL) into a standalone MCP server project through
  a Forge transformer: external `$ref` bundling, synthesised and uniquified
  `operationId`s, and one MCP tool per operation with typed arguments taken from
  the spec. `spec2mcp serve` runs a spec directly without generating a project.
- **Streamable HTTP transport.** Both `serve` and generated projects can expose
  the server over Streamable HTTP (with SSE and per-client sessions) in addition
  to stdio. The HTTP listener binds to loopback, validates Host and Origin, and
  carries no client authentication; it is for local use only.
- **Auth from the spec, overridable per operation.** `securitySchemes` (HTTP
  bearer and basic, apiKey in header or query, OAuth2/OIDC as a pre-minted
  bearer token) map to environment variables; operation-level `security` wins
  over the root requirement, an explicit `security: []` sends no credentials,
  and the first fully mappable OR alternative is used. Unsupported schemes
  produce generation-time warnings rather than failures.
- **Tool filtering and project config.** Repeatable `--include` / `--exclude`
  selectors (exact `tag:` matches or `operationId` globs) choose which
  operations become tools. `spec2mcp.config.json` persists name, base URL and
  selectors; the generated server re-reads it at startup, and CLI flags
  override config keys.
- **Multipart request bodies.** `multipart/form-data` bodies become one argument
  per form field and are sent as a real `FormData` request; file fields accept
  base64 content with optional filename and MIME type.
- **Response output schemas and media handling.** Tools with a known JSON
  success schema emit an `outputSchema` and return `structuredContent`. Non-JSON
  responses map to MCP content types (images, audio, other binary as embedded
  blob resources). Responses are capped - 50,000 characters for text, 4 MiB for
  binary - with `SPEC2MCP_MAX_RESPONSE_CHARS` / `SPEC2MCP_MAX_BINARY_BYTES`
  overrides.
- **Watch mode.** `generate --watch` regenerates the project when a local spec
  changes; for URLs it polls every 30 seconds (`--poll-interval` to adjust),
  retries failed generations, and keeps watching after errors.

[Unreleased]: https://github.com/rowkavdev/spec2mcp/compare/main...HEAD
