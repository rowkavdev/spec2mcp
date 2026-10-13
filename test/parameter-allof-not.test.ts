import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
for (const version of ['3.0.3','3.1.0']) for (const location of ['query','header','cookie','path']) test(`${version} ${location} allOf branch exclusion`, async () => {
 const doc:any={openapi:version,info:{title:'Probe',version:'1'},components:{schemas:{}},paths:{[location==='path'?'/x/{v}':'/x']:{get:{operationId:'x',parameters:[{name:'v',in:location,required:true,schema:{type:'integer',allOf:[{type:'integer',not:{enum:[4]}}]}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc); const tool=buildManifest(doc).tools[0]!;
 const validate=compileOutputValidator(tool.inputSchema);
 assert.equal(validate({v:3}),true); assert.equal(validate({v:4}),false);
});

test('excluded allOf query value does not reach upstream', async () => {
 const { createServer } = await import('node:http');
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
 const seen:string[]=[];
 const api=createServer((req,res)=>{seen.push(req.url!);res.writeHead(204);res.end();});
 await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));
 const doc:any={openapi:'3.1.0',info:{title:'Probe',version:'1'},components:{schemas:{}},paths:{'/x':{get:{operationId:'x',parameters:[{name:'v',in:'query',required:true,schema:{type:'integer',allOf:[{type:'integer',not:{enum:[4]}}]}}],responses:{'204':{description:'ok'}}}}}};
 let client:any,server:any;
 try {
  await init(doc);server=await runHttpServer(buildManifest(doc,{baseUrl:`http://127.0.0.1:${(api.address() as any).port}`}),{port:0});
  client=new Client({name:'probe',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result=await client.callTool({name:'x',arguments:{v:4}});
  assert.equal(seen.length,0);assert.equal(result.isError,true);
  const good = await client.callTool({name:'x',arguments:{v:3}});assert.equal(good.isError,undefined);assert.deepEqual(seen,['/x?v=3']);
 } finally {await client?.close();server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(r));api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));}
});

for(const version of ['3.0.3','3.1.0','3.1.1'])for(const location of ['path','query','header','cookie'])for(const items of [false,true])for(const loaded of [false,true])test(`${version} ${location} items=${items} loaded=${loaded} ref negation`,async()=>{
 const scalar={type:'integer',allOf:[{$ref:'#/components/schemas/Branch'}]};
 let doc:any={openapi:version,info:{title:'Controls',version:'1'},components:{schemas:{Branch:{type:'integer',minimum:2,not:{$ref:'#/components/schemas/Excluded'}},Excluded:{enum:[4]}}},paths:{[location==='path'?'/x/{v}':'/x']:{get:{operationId:'x',parameters:[{name:'v',in:location,required:true,schema:items?{type:'array',items:scalar}:scalar}],responses:{'204':{description:'ok'}}}}}};
 if(loaded){const{loadSpec}=await import('../src/load.js');const{mkdtemp,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'allofnot-'));try{const p=join(dir,'spec.json');await writeFile(p,JSON.stringify(doc));doc=await loadSpec(p);}finally{await rm(dir,{recursive:true,force:true});}}
 await init(doc);const tool=buildManifest(doc).tools[0]!;const val=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));const wrap=(n:number)=>({v:items?[n]:n});assert.equal(val(wrap(3)),true);assert.equal(val(wrap(4)),false);assert.equal(val(wrap(1)),false);assert.equal(val(wrap(2.5)),false);
});
for(const version of ['3.0.3','3.1.0'])test(`${version} allOf branch negated ref siblings follow version`,async()=>{
 const doc:any={openapi:version,info:{title:'Sibling',version:'1'},components:{schemas:{Excluded:{type:'integer',minimum:2}}},paths:{'/x':{get:{operationId:'x',parameters:[{name:'v',in:'query',schema:{type:'integer',allOf:[{type:'integer',not:{$ref:'#/components/schemas/Excluded',maximum:5}}]}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({v:1}),true);assert.equal(val({v:3}),false);assert.equal(val({v:9}),version==='3.1.0');
});
for(const [kind,not,schemas]of [['oversized',{not:{const:'x'.repeat(100000)}},{}],['missing',{$ref:'#/components/schemas/Missing'},{}],['cyclic',{$ref:'#/components/schemas/Loop'},{Loop:{$ref:'#/components/schemas/Loop'}}]]as any[])test(`${kind} branch not omission preserves positive bound`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Fallback',version:'1'},components:{schemas},paths:{'/x':{get:{operationId:'x',parameters:[{name:'v',in:'query',schema:{type:'integer',allOf:[{type:'integer',minimum:2,not}]}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const manifest=buildManifest(doc);assert.ok(manifest.warnings?.some(w=>w.includes('allOf branch not constraint omitted')));const val=compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));assert.equal(val({v:3}),true);assert.equal(val({v:1}),false);
});

test('branch negation preserves flat metadata and nullable policy',async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Metadata',version:'1'},components:{schemas:{}},paths:{'/x':{get:{operationId:'x',parameters:[{name:'v',in:'query',description:'Value note',schema:{type:'integer',default:3,nullable:true,enum:[3,4],allOf:[{type:'integer',format:'email',not:{enum:[4,null]}}]}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;const schema=tool.args[0]!.schema;assert.equal(schema.default,3);assert.equal(schema.description,'Value note');assert.equal(schema.format,undefined);assert.deepEqual(schema.enum,[3,4]);const val=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));assert.equal(val({v:3}),true);assert.equal(val({v:4}),false);assert.equal(val({v:null}),false);
});
