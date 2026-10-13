import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
test('multipart field retains OpenAPI 3.1 ref sibling bound', async () => {
 const doc: any = { openapi: '3.1.0', info: { title: 'Multipart bound', version: '1' }, components: { schemas: { Score: { type: 'integer', minimum: 0 } } }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['score'], properties: { score: { $ref: '#/components/schemas/Score', maximum: 5 } } } } } }, responses: { '204': { description: 'ok' } } } } } };
 await init(doc); const tool = buildManifest(doc).tools[0]!;
 const validate = compileOutputValidator(tool.inputSchema);
 assert.equal(validate({ score: 3 }), true);
 assert.equal(validate({ score: 9 }), false);
});

test('multipart ref sibling bound rejects before mock API', async () => {
 const { createServer } = await import('node:http');
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
 const seen: string[] = [];
 const api = createServer((req, res) => { seen.push(req.url!); res.writeHead(204); res.end(); });
 await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
 const doc: any = { openapi: '3.1.0', info: { title: 'Multipart bound', version: '1' }, components: { schemas: { Score: { type: 'integer', minimum: 0 } } }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['score'], properties: { score: { $ref: '#/components/schemas/Score', maximum: 5 } } } } } }, responses: { '204': { description: 'ok' } } } } } };
 let server: any; let client: any;
 try {
  await init(doc); server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as any).port}` }), { port: 0 });
  client = new Client({ name: 'boolean-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await client.callTool({ name: 'post', arguments: { score: 9 } });
  assert.equal(result.isError, true);
  assert.equal(seen.length, 0);
  const good = await client.callTool({ name: 'post', arguments: { score: 3 } });
  assert.equal(good.isError, undefined);
  assert.equal(seen.length, 1);
 } finally {
  await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
  api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
 }
});

for(const version of ['3.0.3','3.1.0','3.1.1'])for(const media of ['multipart/form-data','multipart/form-data; boundary=ignored'])for(const kind of ['scalar','chain','array','object'])test(`${version} ${media} ${kind} ref siblings`,async()=>{
 const schemas:any={Score:{type:'integer',minimum:0},Hop:{$ref:'#/components/schemas/Score',maximum:5}};
 const schema:any=kind==='scalar'?{$ref:'#/components/schemas/Score',maximum:5}:kind==='chain'?{$ref:'#/components/schemas/Hop',maximum:4}:kind==='array'?{type:'array',items:{$ref:'#/components/schemas/Score',maximum:5}}:{type:'object',properties:{value:{$ref:'#/components/schemas/Score',maximum:5}},required:['value']};
 const doc:any={openapi:version,info:{title:'Multipart refs',version:'1'},components:{schemas},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{[media]:{schema:{type:'object',required:['score'],properties:{score:schema}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;const validate=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));const wrap=(n:number)=>({score:kind==='array'?[n]:kind==='object'?{value:n}:n});
 assert.equal(validate(wrap(3)),true);assert.equal(validate(wrap(9)),version==='3.0.3');assert.equal(validate(wrap(-1)),false);assert.deepEqual(tool.args.map(a=>a.name),['score']);
});

for(const [label,sibling,schemas]of [
 ['oversized negation',{not:{const:'x'.repeat(100000)}},{}],
 ['unresolved negation',{not:{$ref:'#/components/schemas/Missing'}},{}],
 ['cyclic negation',{not:{$ref:'#/components/schemas/Loop'}},{Loop:{$ref:'#/components/schemas/Loop'}}],
]as any[])test(`3.1 multipart ${label} uses complete adapted fallback`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Fallback',version:'1'},components:{schemas:{Score:{type:'integer',minimum:0},...schemas}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'multipart/form-data':{schema:{type:'object',required:['score'],properties:{score:{$ref:'#/components/schemas/Score',...sibling}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const manifest=buildManifest(doc);assert.ok(manifest.warnings?.some(w=>w.includes('multipart field "score"')&&w.includes('adapted schema')));const schema=manifest.tools[0]!.args[0]!.schema;assert.equal(schema.not,undefined);assert.equal(schema.allOf,undefined);assert.equal(compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)))({score:3}),true);
});
for(const version of ['3.0.3','3.1.0'])test(`${version} multipart inline annotations and binary shape stay intact`,async()=>{
 const doc:any={openapi:version,info:{title:'Controls',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'multipart/form-data':{schema:{type:'object',required:['score','file'],properties:{score:{type:'integer',minimum:0,default:3,description:'Score note'},file:{type:'string',format:'binary'}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;const score=tool.args.find(a=>a.name==='score')!;assert.equal(score.schema.description,'Score note');assert.equal(score.schema.default,3);assert.equal(score.schema.minimum,0);assert.equal(score.required,true);const file=tool.args.find(a=>a.name==='file')!;assert.equal(file.binary,true);assert.deepEqual(file.schema.required,['contentBase64']);assert.equal(file.schema.additionalProperties,false);
});
