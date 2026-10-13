import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
test('flattened JSON body scalar keeps negation', async () => {
 const doc: any = { openapi: '3.0.3', info: { title: 'Body negation', version: '1' }, components: { schemas: {} }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', not: { enum: ['blocked'] } } } } } } }, responses: { '204': { description: 'ok' } } } } } };
 await init(doc); const tool = buildManifest(doc).tools[0]!;
 const validate = compileOutputValidator(tool.inputSchema);
 assert.equal(validate({ mode: 'allowed' }), true);
 assert.equal(validate({ mode: 'blocked' }), false);
});

test('body leaf negation rejects before mock API', async () => {
 const { createServer } = await import('node:http');
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
 const seen: string[] = [];
 const api = createServer((req, res) => { seen.push(req.url!); res.writeHead(204); res.end(); });
 await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
 const doc: any = { openapi: '3.0.3', info: { title: 'Body negation', version: '1' }, components: { schemas: {} }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', not: { enum: ['blocked'] } } } } } } }, responses: { '204': { description: 'ok' } } } } } };
 let server: any; let client: any;
 try {
  await init(doc); server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as any).port}` }), { port: 0 });
  client = new Client({ name: 'boolean-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await client.callTool({ name: 'post', arguments: { mode: 'blocked' } });
  assert.equal(result.isError, true);
  assert.equal(seen.length, 0);
  const good = await client.callTool({ name: 'post', arguments: { mode: 'allowed' } });
  assert.equal(good.isError, undefined);
  assert.equal(seen.length, 1);
 } finally {
  await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
  api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
 }
});

for(const version of ['3.0.3','3.1.0','3.1.1'])for(const ref of [false,true])for(const loaded of [false,true])test(`${version} ref=${ref} loaded=${loaded} scalar negation`,async()=>{
 const leaf={type:'string',enum:['allowed','blocked'],minLength:3,description:'Mode note',default:'allowed',not:ref?{$ref:'#/components/schemas/Blocked'}:{enum:['blocked']}};
 let doc:any={openapi:version,info:{title:'Negation',version:'1'},components:{schemas:{Leaf:leaf,Blocked:{enum:['blocked']}}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['mode'],properties:{mode:ref?{$ref:'#/components/schemas/Leaf'}:leaf}}}}},responses:{'204':{description:'ok'}}}}}};
 if(loaded){const{loadSpec}=await import('../src/load.js');const{mkdtemp,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'bodynot-'));try{const p=join(dir,'spec.json');await writeFile(p,JSON.stringify(doc));doc=await loadSpec(p);}finally{await rm(dir,{recursive:true,force:true});}}
 await init(doc);const tool=buildManifest(doc).tools[0]!;assert.deepEqual(tool.args.map(a=>a.name),['mode']);const arg=tool.args[0]!.schema;assert.equal(arg.description,'Mode note');assert.equal(arg.default,'allowed');const val=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));assert.equal(val({mode:'allowed'}),true);assert.equal(val({mode:'blocked'}),false);assert.equal(val({mode:'x'}),false);assert.equal(val({}),false);
});
for(const version of ['3.0.3','3.1.0'])test(`${version} negated ref sibling intersection`,async()=>{
 const doc:any={openapi:version,info:{title:'Sibling',version:'1'},components:{schemas:{Excluded:{type:'integer',minimum:2}}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['value'],properties:{value:{type:'integer',not:{$ref:'#/components/schemas/Excluded',maximum:5}}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({value:1}),true);assert.equal(val({value:3}),false);assert.equal(val({value:9}),version==='3.1.0');
});
for(const [kind,not,schemas]of [
 ['oversized',{not:{const:'x'.repeat(100000)}},{}],['missing',{$ref:'#/components/schemas/Missing'},{}],['cyclic',{$ref:'#/components/schemas/Loop'},{Loop:{$ref:'#/components/schemas/Loop'}}],
]as any[])test(`${kind} scalar not fallback omits entire negative subtree`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Fallback',version:'1'},components:{schemas},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['mode'],properties:{mode:{type:'string',not}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const manifest=buildManifest(doc);assert.equal(manifest.tools[0]!.args[0]!.schema.not,undefined);assert.ok(manifest.warnings?.some(w=>w.includes('not constraint omitted')));assert.equal(compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)))({mode:'allowed'}),true);
});
test('nested negation and existing nullable wrapper remain separate',async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Nested',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/problem+json':{schema:{type:'object',required:['pet'],properties:{pet:{type:'object',required:['value'],properties:{value:{type:'integer',nullable:true,not:{not:{enum:[2,3]}}}}}}}}},responses:{'204':{description:'ok'}}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;assert.deepEqual(tool.args.map(a=>a.name),['pet.value']);const val=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));assert.equal(val({'pet.value':2}),true);assert.equal(val({'pet.value':9}),false);assert.equal(val({'pet.value':null}),true);
});
