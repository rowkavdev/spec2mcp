import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
test('multipart file arrays keep their declared item count bounds', async () => {
 const doc: any = { openapi: '3.0.3', info: { title: 'Upload count', version: '1' }, components: { schemas: {} }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', format: 'binary' } } } } } } }, responses: { '204': { description: 'ok' } } } } } };
 await init(doc); const tool = buildManifest(doc).tools[0]!;
 const validate = compileOutputValidator(tool.inputSchema);
 assert.equal(validate({ files: [{contentBase64: 'YQ=='}] }), true);
 assert.equal(validate({ files: [] }), false);
});

test('empty required file array rejects before mock API', async () => {
 const { createServer } = await import('node:http');
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
 const seen: string[] = [];
 const api = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { seen.push(body); res.writeHead(204); res.end(); }); });
 await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
 const doc: any = { openapi: '3.0.3', info: { title: 'Upload count', version: '1' }, components: { schemas: {} }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', format: 'binary' } } } } } } }, responses: { '204': { description: 'ok' } } } } } };
 let server: any; let client: any;
 try {
  await init(doc); server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as any).port}` }), { port: 0 });
  client = new Client({ name: 'boolean-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await client.callTool({ name: 'post', arguments: { files: [] } });
  assert.equal(result.isError, true);
  assert.equal(seen.length, 0);
  const tooMany = await client.callTool({ name: 'post', arguments: { files: Array(3).fill({ contentBase64: 'YQ==' }) } });
  assert.equal(tooMany.isError, true);
  assert.equal(seen.length, 0);
  const good = await client.callTool({ name: 'post', arguments: { files: [{ contentBase64: 'YQ==', filename: 'one.txt', mimeType: 'text/plain' }] } });
  assert.equal(good.isError, undefined);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.includes('name="files"; filename="one.txt"'));
  assert.ok(seen[0]!.includes('Content-Type: text/plain'));
  assert.ok(seen[0]!.includes('\r\na\r\n'));
 } finally {
  await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
  api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
 }
});

for(const version of ['3.0.3','3.1.0','3.1.1'])for(const reference of [false,true])for(const loaded of [false,true])for(const required of [false,true])for(const media of ['multipart/form-data','multipart/form-data; boundary=ignored'])test(`${version} ref=${reference} loaded=${loaded} required=${required} ${media} counts`,async()=>{
 const source={type:'array',minItems:1,maxItems:2,description:'Files note',items:{type:'string',format:'binary'}};
 let doc:any={openapi:version,info:{title:'Count controls',version:'1'},components:{schemas:{Files:source}},paths:{'/':{post:{operationId:'post',requestBody:{required,content:{[media]:{schema:{type:'object',...(required?{required:['files']} : {}),properties:{files:reference?{$ref:'#/components/schemas/Files'}:source}}}},responses:{'204':{description:'ok'}}}}}}};
 if(loaded){const{loadSpec}=await import('../src/load.js');const{mkdtemp,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'file-count-'));try{const p=join(dir,'spec.json');await writeFile(p,JSON.stringify(doc));doc=await loadSpec(p);}finally{await rm(dir,{recursive:true,force:true});}}
 await init(doc);const tool=buildManifest(doc).tools[0]!;const arg=tool.args[0]!;assert.equal(arg.name,'files');assert.equal(arg.binaryArray,true);assert.equal(arg.schema.description,'Files note');assert.equal(arg.schema.minItems,1);assert.equal(arg.schema.maxItems,2);assert.deepEqual((arg.schema.items as any).required,['contentBase64']);
 const validate=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));assert.equal(validate({}),!required);for(const n of [0,1,2,3])assert.equal(validate({files:Array(n).fill({contentBase64:'YQ=='})}),n>=1&&n<=2);
});
for(const version of ['3.0.3','3.1.0'])test(`${version} binary array ref-hop count intersections`,async()=>{
 const doc:any={openapi:version,info:{title:'Count refs',version:'1'},components:{schemas:{Files:{type:'array',minItems:1,maxItems:5,items:{type:'string',format:'binary'}},Hop:{$ref:'#/components/schemas/Files',minItems:2,maxItems:4}}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'multipart/form-data':{schema:{type:'object',required:['files'],properties:{files:{$ref:'#/components/schemas/Hop',maxItems:3}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const arg=buildManifest(doc).tools[0]!.args[0]!;assert.equal(arg.schema.minItems,version==='3.0.3'?1:2);assert.equal(arg.schema.maxItems,version==='3.0.3'?5:3);
});
for(const kind of ['missing','cyclic','budget'])test(`binary array ${kind} recovery retains direct bounds`,async()=>{
 const extra=kind==='missing'?{$ref:'#/components/schemas/Missing'}:kind==='cyclic'?{$ref:'#/components/schemas/Loop'}:{allOf:Array.from({length:4200},()=>({}))};
 const doc:any={openapi:'3.1.0',info:{title:'Count fallback',version:'1'},components:{schemas:{Loop:{$ref:'#/components/schemas/Loop'}}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'multipart/form-data':{schema:{type:'object',required:['files'],properties:{files:{type:'array',minItems:1,maxItems:2,items:{type:'string',format:'binary'},allOf:[extra]}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const manifest=buildManifest(doc);const arg=manifest.tools[0]!.args[0]!;assert.equal(arg.schema.minItems,1);assert.equal(arg.schema.maxItems,2);assert.equal(manifest.warnings?.filter(w=>w.includes('array count recovery incomplete')).length,1);
});

for(const kind of ['single','unbounded','zero'])test(`binary ${kind} compatibility control`,async()=>{
 const file={type:'string',format:'binary'};const schema=kind==='single'?file:{type:'array',...(kind==='zero'?{minItems:0,maxItems:0}:{}),items:file};
 const doc:any={openapi:'3.1.0',info:{title:'Compatibility',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:false,content:{'multipart/form-data':{schema:{type:'object',properties:{files:schema}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;const arg=tool.args[0]!;const validate=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));assert.equal(validate({}),true);
 if(kind==='single'){assert.equal(arg.binaryArray,undefined);assert.equal(arg.schema.minItems,undefined);assert.equal(validate({files:{contentBase64:'YQ=='}}),true);}else{assert.equal(validate({files:[]}),true);assert.equal(validate({files:[{contentBase64:'YQ=='}]}),kind==='unbounded');}
});
