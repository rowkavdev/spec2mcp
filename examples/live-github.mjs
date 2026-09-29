/**
 * Live dogfood: generate an MCP server from GitHub's official OpenAPI spec
 * and call the real api.github.com through it via the official MCP client.
 *
 * Manual run (needs network, no token - anonymous GitHub API):
 *   node examples/live-github.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SPEC = process.argv[2] ?? 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json';

const dir = await mkdtemp(join(tmpdir(), 'spec2mcp-live-'));
try {
  console.log(`[1/4] generating from ${SPEC}`);
  await new Promise((resolve, reject) => {
    const p = spawn('node', ['dist/cli.mjs', 'generate', SPEC, '--out', join(dir, 'github-mcp')], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`generate exited ${code}`))));
  });

  console.log('[2/5] npm install inside the generated project (the real user flow)');
  await new Promise((resolve, reject) => {
    const p = spawn('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: join(dir, 'github-mcp'), stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited ${code}`))));
  });

  console.log('[3/5] connecting an MCP client over stdio');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(dir, 'github-mcp', 'server.mjs')],
    env: { ...process.env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'spec2mcp-dogfood', version: '0.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`[4/5] server exposes ${tools.length} tools; sample: ${tools.slice(0, 5).map((t) => t.name).join(', ')}`);

  console.log('[5/5] calling repos_get(rowkavdev, ghostdeps) against live api.github.com');
  const res = await client.callTool({ name: 'repos_get', arguments: { owner: 'rowkavdev', repo: 'ghostdeps' } });
  const text = res.content[0].text;
  const parsed = JSON.parse(text);
  console.log(`  -> ${parsed.full_name} | stars ${parsed.stargazers_count} | ${parsed.description?.slice(0, 60)}`);

  await client.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
