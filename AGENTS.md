# spec2mcp

Turn any OpenAPI 3.x spec into a working MCP server. A transformer for Cloudflare's Forge pipeline (vendored, see vendor/forge/PINNED.md).

## Layout

- `src/` - CLI (`cli.ts`), spec loader (`load.ts`), auth mapping (`auth.ts`), manifest builder (`manifest.ts`), Forge transformer (`transformer.ts`), naming helpers (`naming.ts`).
- `runtime/server.mjs` - plain-JS runtime copied verbatim into every generated project. The same file powers `spec2mcp serve`. Its only dependency is `@modelcontextprotocol/sdk`. Never write to stdout here - stdout is the MCP protocol channel.
- `vendor/forge/` - pinned `@cloudflare/forge` source (Apache-2.0). Do not edit casually; to update, re-vendor the pinned upstream `packages/forge` source and retain `vendor/forge/LICENSE` and `PINNED.md` attribution.
- `test/` - node:test. Unit tests use fixture specs; `e2e.test.ts` boots a generated server and drives a real MCP session against a mock HTTP API. `compat.test.ts` is the real-spec matrix: pinned snapshots of Stripe, Kubernetes, Spotify and Vercel in `test/fixtures/compat/`, refreshed from live sources with `npm run compat:refresh` (network, not CI).
- `examples/` - ready-to-run generated projects (`petstore/`, `notes-api/`, `petstore-readonly/`), the offline `demo.mts`, and `live-github.mjs`, the manual live-API dogfood (not run in CI). Committed examples are drift-checked by `test/examples.test.ts`; regenerate them per `examples/README.md`.

## Commands

```bash
npm install
npm run typecheck   # strict tsc over src + vendor
npm run build       # esbuild -> dist/cli.mjs
npm test            # unit + e2e
```

## Contribution rules

- Every change lands via PR with granular commits (one change per commit); PRs are rebase-merged, never squashed.
- Never merge on red. CI is typecheck + build + tests on Node 22 and 24.
- The generated project must stay dependency-light: `@modelcontextprotocol/sdk` only.
- `runtime/server.mjs` changes need the e2e test to pass and a manual `node examples/live-github.mjs` run before merge.
