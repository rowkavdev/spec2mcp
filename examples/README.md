# Examples

Each directory here is a complete, ready-to-run MCP server project generated
by spec2mcp from the bundled OpenAPI spec, plus the spec itself
(`openapi.yaml`). No Docker, one dependency (`@modelcontextprotocol/sdk`),
runs with plain `node` on Node 22+.

```bash
cd petstore        # or notes-api, petstore-readonly
npm install
npm start          # stdio MCP server
```

| Example | Shows | Tools |
| --- | --- | --- |
| `petstore/` | The hello-world: a small pet store spec turned into a server | `list_pets`, `create_pet`, `get_pet`, `delete_pet` |
| `notes-api/` | Auth via environment variables - the spec requires a bearer token, and the server reads `NOTES_API_BEARER_AUTH` (see its `.env.example`) | `list_notes`, `create_note`, `get_note`, `delete_note` |
| `petstore-readonly/` | Filtering and saved config - the spec mixes public and admin operations, and only the `pets` tag ships, recorded in `spec2mcp.config.json` | `list_pets`, `get_pet` |

The example specs use placeholder base URLs (`*.example`). Point a server at
a real API by setting the base-URL env var from its `.env.example`, or
regenerate with `--base-url`.

## Demo

```bash
npm run demo
```

`demo.mts` regenerates the petstore server, boots it over stdio, and calls
`list_pets` and `get_pet` through the official MCP client against a local
stub API - the short, fully offline flow to record for a gif.

`live-github.mjs` is the manual live-API dogfood: it generates a server from
GitHub's real OpenAPI spec and calls api.github.com through it (needs
network; not run in CI).

## Regenerating

Each example carries a committed `spec2mcp.config.json` that records how it
was generated, so regeneration needs no flags:

```bash
node node_modules/tsx/dist/cli.mjs src/cli.ts generate \
  examples/<name>/openapi.yaml \
  --config examples/<name>/spec2mcp.config.json \
  --out examples/<name>
```

(Or `spec2mcp generate ...` from an installed CLI.) `test/examples.test.ts`
runs exactly this and diffs the result, so the examples always match the
current generator - regenerate and commit them whenever generator output
changes on purpose.
