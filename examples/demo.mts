/**
 * Demo: generate an MCP server from the bundled petstore spec and call its
 * tools through the official MCP client - the 20-second version of the
 * README flow. Runs fully offline against a local stub pet store API, so it
 * works in a terminal recording or a conference talk with no network.
 *
 *   npm run demo
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SPEC = fileURLToPath(new URL('./petstore/openapi.yaml', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL('.', import.meta.url));

const PETS = [
  { id: 1, name: 'Rex', tag: 'dog' },
  { id: 2, name: 'Whiskers', tag: 'cat' },
  { id: 3, name: 'Nemo', tag: 'fish' },
];

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

function print(text: string): void {
  // The generated server can truncate long bodies; the demo's payloads are tiny.
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

// A stub petstore API: just enough of the spec to answer real HTTP calls.
const api = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'GET' && url.pathname === '/v1/pets') {
    const tag = url.searchParams.get('tag');
    const limit = Number(url.searchParams.get('limit') ?? PETS.length);
    send(200, PETS.filter((pet) => !tag || pet.tag === tag).slice(0, limit));
    return;
  }
  const match = /^\/v1\/pets\/(\d+)$/.exec(url.pathname);
  if (req.method === 'GET' && match) {
    const pet = PETS.find((candidate) => candidate.id === Number(match[1]));
    if (pet) send(200, pet);
    else send(404, { message: `no pet with id ${match[1]}` });
    return;
  }
  send(404, { message: 'not found' });
});

await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`;

// Scratch dir inside the repo so the generated server.mjs resolves
// @modelcontextprotocol/sdk from this repo's node_modules (no npm install).
const scratch = await mkdtemp(join(EXAMPLES_DIR, '.tmp-demo-'));
let client: Client | undefined;
try {
  console.log(`\n$ spec2mcp generate examples/petstore/openapi.yaml --base-url ${baseUrl}\n`);
  await run(process.execPath, [TSX, CLI, 'generate', SPEC, '--out', join(scratch, 'pet-store-mcp'), '--base-url', baseUrl]);

  console.log('\n$ connecting an MCP client over stdio\n');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(scratch, 'pet-store-mcp', 'server.mjs')],
    stderr: 'inherit',
  });
  client = new Client({ name: 'spec2mcp-demo', version: '0.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((tool) => tool.name).join(', ')}\n`);

  console.log('$ list_pets({ tag: "dog" })\n');
  const list = await client.callTool({ name: 'list_pets', arguments: { tag: 'dog' } });
  print((list.content as Array<{ text?: string }>)[0]?.text ?? '');

  console.log('\n$ get_pet({ petId: 2 })\n');
  const one = await client.callTool({ name: 'get_pet', arguments: { petId: 2 } });
  print((one.content as Array<{ text?: string }>)[0]?.text ?? '');
} finally {
  await client?.close();
  api.close();
  await rm(scratch, { recursive: true, force: true });
}
