import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
test('numeric JSON body field retains enum', async () => {
 const doc: any = { openapi: '3.0.3', info: { title: 'Numeric enum', version: '1' }, components: { schemas: {} }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['level'], properties: { level: { type: 'integer', enum: [1,2] } } } } } }, responses: { '204': { description: 'ok' } } } } } };
 await init(doc); const tool = buildManifest(doc).tools[0]!;
 const validate = compileOutputValidator(tool.inputSchema);
 assert.equal(validate({ level: 1 }), true);
 assert.equal(validate({ level: 9 }), false);
});

test('numeric body enum rejects before mock API', async () => {
 const { createServer } = await import('node:http');
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
 const seen: string[] = [];
 const api = createServer((req, res) => { seen.push(req.url!); res.writeHead(204); res.end(); });
 await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
 const doc: any = { openapi: '3.0.3', info: { title: 'Numeric enum', version: '1' }, components: { schemas: {} }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['level'], properties: { level: { type: 'integer', enum: [1,2] } } } } } }, responses: { '204': { description: 'ok' } } } } } };
 let server: any; let client: any;
 try {
  await init(doc); server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as any).port}` }), { port: 0 });
  client = new Client({ name: 'boolean-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await client.callTool({ name: 'post', arguments: { level: 9 } });
  assert.equal(result.isError, true);
  assert.equal(seen.length, 0);
  const good = await client.callTool({ name: 'post', arguments: { level: 1 } });
  assert.equal(good.isError, undefined);
  assert.equal(seen.length, 1);
 } finally {
  await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
  api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
 }
});

for(const version of ['3.0.3','3.1.0','3.1.1'])for(const reference of [false,true])for(const loaded of [false,true])for(const [kind,type,values,good,bad,nullable] of [
 ['number','integer',[1,2],1,9,false],['boolean','boolean',[true],true,false,false],['mixed','integer',[1,'2',null],1,2,true],['null','string',[null],null,'x',true],['string','string',['','safe'],'','bad',false],
] as any[])test(`${version} ref=${reference} loaded=${loaded} ${kind} scalar enum`,async()=>{
 const leaf={type,enum:values,...(nullable?{nullable:true}:{}),description:'Level note',default:good};
 let doc:any={openapi:version,info:{title:'Enums',version:'1'},components:{schemas:{Leaf:leaf}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['level'],properties:{level:reference?{$ref:'#/components/schemas/Leaf'}:leaf}}}}},responses:{'204':{description:'ok'}}}}}};
 if(loaded){const{loadSpec}=await import('../src/load.js');const{mkdtemp,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'scalarenum-'));try{const p=join(dir,'spec.json');await writeFile(p,JSON.stringify(doc));doc=await loadSpec(p);}finally{await rm(dir,{recursive:true,force:true});}}
 await init(doc);const tool=buildManifest(doc).tools[0]!;assert.deepEqual(tool.args.map(a=>a.name),['level']);const validate=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));assert.equal(validate({level:good}),true);assert.equal(validate({level:bad}),false);assert.equal(validate({}),false);
 const arg:any=tool.args[0]!.schema;const inner=nullable?arg.anyOf[0]:arg;assert.deepEqual(inner.enum,values);assert.equal(inner.description,'Level note');
});

for(const version of ['3.0.3','3.1.0'])for(const media of ['application/json','application/problem+json'])test(`${version} ${media} enum intersects bounds and keeps nullable policy`,async()=>{
 const doc:any={openapi:version,info:{title:'Constraints',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{[media]:{schema:{type:'object',required:['pet'],properties:{pet:{type:'object',required:['level'],properties:{level:{type:'integer',enum:[1,2,3],minimum:2,maximum:3,nullable:true,default:2,description:'Note'}}}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;assert.deepEqual(tool.args.map(a=>a.name),['pet.level']);const validate=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));assert.equal(validate({'pet.level':2}),true);assert.equal(validate({'pet.level':1}),false);assert.equal(validate({'pet.level':9}),false);assert.equal(validate({'pet.level':2.5}),false);assert.equal(validate({'pet.level':null}),true);const inner:any=(tool.args[0]!.schema.anyOf as any[])[0];assert.equal(inner.default,2);assert.equal(inner.description,'Note');
});
for(const [kind,values]of [['empty',[]],['nonprimitive',[{x:1}]],['mixedNonprimitive',['safe',{x:1}]]]as any[])test(`${kind} enum retains adapted boundary`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Boundary',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['level'],properties:{level:{type:'string',enum:values}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const schema=buildManifest(doc).tools[0]!.args[0]!.schema;assert.deepEqual(schema.enum,kind==='mixedNonprimitive'?['safe']:undefined);
});
test('oversized exact primitive enum retains adapted view with warning',async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Budget',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['level'],properties:{level:{type:'integer',enum:Array.from({length:3000},(_,i)=>i)}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const manifest=buildManifest(doc);assert.ok(manifest.warnings?.some(w=>w.includes('enum exceeds the input budget')));assert.equal(manifest.tools[0]!.args[0]!.schema.enum,undefined);
});
