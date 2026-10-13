import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
for (const location of ['query','header','cookie']) for (const [label,extra,good,bad] of [
 ['not',{not:{contains:{const:4}}},[3],[4]],
 ['contains',{contains:{const:4}},[4],[3]],
 ['allOf count',{allOf:[{minItems:2}]},[3,4],[3]],
] as const) test(`${location} array ${label}`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Array',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:location,required:true,schema:{type:'array',items:{type:'integer'},...extra}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;const validate=compileOutputValidator(tool.inputSchema);assert.equal(validate({v:good}),true);assert.equal(validate({v:bad}),false);
});
for (const [label,extra,bad] of [ ['allOf count',{allOf:[{minItems:2}]},[3]], ['contains',{contains:{const:4}},[3]], ['not',{not:{contains:{const:4}}},[4]] ] as const) test(`query array ${label} rejects before HTTP`,async()=>{
 const { createServer }=await import('node:http');
 const { Client }=await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport }=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer }=await import(new URL('../runtime/server.mjs',import.meta.url).href);
 const seen:string[]=[];const api=createServer((req,res)=>{seen.push(req.url!);res.writeHead(204);res.end();});await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));
 const source={type:'array',items:{type:'integer'},...extra};
 assert.equal(compileOutputValidator(source)(bad),false,'source schema rejects this array');
 const doc:any={openapi:'3.1.0',info:{title:'Array',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',required:true,schema:source}],responses:{'204':{description:'ok'}}}}}};
 let client:any,server:any;
 try{await init(doc);server=await runHttpServer(buildManifest(doc,{baseUrl:`http://127.0.0.1:${(api.address() as any).port}`}),{port:0});client=new Client({name:'probe',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));const result=await client.callTool({name:'get',arguments:{v:bad}});assert.equal(seen.length,0);assert.equal(result.isError,true);const good=await client.callTool({name:'get',arguments:{v:label==='allOf count'?[3,4]:label==='contains'?[4]:[3]}});assert.equal(good.isError,undefined);assert.deepEqual(seen,label==='allOf count'?['/?v=3&v=4']:label==='contains'?['/?v=4']:['/?v=3']);const nested=await client.callTool({name:'get',arguments:{v:[{x:3}]}});assert.equal(nested.isError,true);assert.equal(seen.length,1);}
 finally{await client?.close();server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(r));api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));}
});

for(const version of ['3.0.3','3.1.0','3.1.1'])for(const location of ['path','query','header','cookie'])for(const loaded of [false,true])for(const composed of [false,true])test(`${version} ${location} loaded=${loaded} composed=${composed} array shell`,async()=>{
 const arr={type:'array',items:composed?{anyOf:[{type:'integer',minimum:2},{type:'string',enum:['safe']}]}:{type:'integer',minimum:2},allOf:[{$ref:'#/components/schemas/Counts'}],not:{$ref:'#/components/schemas/Forbidden'},...(version.startsWith('3.1')?{contains:{const:4}}:{})};let doc:any={openapi:version,info:{title:'Shell',version:'1'},components:{schemas:{Counts:{minItems:2,maxItems:3},Forbidden:{enum:[[4,4]]},Arr:arr}},paths:{[location==='path'?'/x/{v}':'/x']:{get:{operationId:'get',parameters:[{name:'v',in:location,required:true,schema:{$ref:'#/components/schemas/Arr'}}],responses:{'204':{description:'ok'}}}}}};
 if(loaded){const{loadSpec}=await import('../src/load.js');const{mkdtemp,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const d=await mkdtemp(join(tmpdir(),'shell-'));try{const p=join(d,'s.json');await writeFile(p,JSON.stringify(doc));doc=await loadSpec(p);}finally{await rm(d,{recursive:true,force:true});}}
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({v:[3,4]}),true);for(const bad of [[3],[4,4],[3,4,5,6],[1,4]])assert.equal(val({v:bad}),false,JSON.stringify(bad));if(version.startsWith('3.1'))assert.equal(val({v:[3,5]}),false);
});
for(const kind of ['anyOf','oneOf'])for(const version of ['3.0.3','3.1.0'])test(`${version} ${kind} complete array alternatives`,async()=>{
 const doc:any={openapi:version,info:{title:'Alternative',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',schema:{type:'array',items:{type:'integer'},[kind]:[{minItems:2,maxItems:2,items:{minimum:2}},{minItems:4,maxItems:4}]}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({v:[3,4]}),true);assert.equal(val({v:[3]}),false);assert.equal(val({v:[1,4]}),false);
});
for(const version of ['3.0.3','3.1.0'])test(`${version} array negated ref sibling version`,async()=>{
 const doc:any={openapi:version,info:{title:'Sibling',version:'1'},components:{schemas:{Count:{minItems:2}}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',schema:{type:'array',items:{type:'integer'},not:{$ref:'#/components/schemas/Count',maxItems:2}}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({v:[3]}),true);assert.equal(val({v:[3,4]}),false);assert.equal(val({v:[3,4,5]}),version==='3.1.0');
});
for(const [kind,not,schemas]of [['oversized',{not:{const:'x'.repeat(100000)}},{}],['missing',{$ref:'#/components/schemas/Missing'},{}],['cycle',{$ref:'#/components/schemas/Loop'},{Loop:{$ref:'#/components/schemas/Loop'}}]]as any[])test(`${kind} array negative omission retains direct and branch bounds`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Fallback',version:'1'},components:{schemas},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',schema:{type:'array',items:{type:'integer'},minItems:2,not,allOf:[{maxItems:3,not}]}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const m=buildManifest(doc);assert.ok(m.warnings?.some(w=>w.includes('array not constraint omitted')));const val=compileOutputValidator(JSON.parse(JSON.stringify(m.tools[0]!.inputSchema)));assert.equal(val({v:[3,4]}),true);assert.equal(val({v:[3]}),false);assert.equal(val({v:[3,4,5,6]}),false);
});
for(const location of ['path','query','header','cookie'])test(`${location} array flat metadata/default/null compatibility`,async()=>{
 const doc:any={openapi:'3.0.3',info:{title:'Compatibility',version:'1'},components:{schemas:{}},paths:{[location==='path'?'/x/{v}':'/x']:{get:{operationId:'get',parameters:[{name:'v',in:location,description:'Values',schema:{type:'array',default:[3,4],nullable:true,items:{type:'integer'},minItems:1,allOf:[{minItems:2}],not:{enum:[[4,4]]}}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;const arg=tool.args[0]!;assert.equal(arg.name,'v');const flat=(arg.schema.anyOf as any[])?.[0]??arg.schema;assert.equal(flat.description,'Values');assert.deepEqual(flat.default,location==='cookie'?[3,4]:undefined);const val=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));assert.equal(val({v:null}),location!=='path');assert.equal(val({v:[3,4]}),true);assert.equal(val({v:[4,4]}),false);
});
test('incomplete or held-policy negative omits whole not without widening underneath it',async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'No policy expansion',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',schema:{type:'array',items:{type:'integer'},minItems:2,not:JSON.parse('{"if":{"minItems":2},"then":{"maxItems":3}}')}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const m=buildManifest(doc);assert.ok(m.warnings?.some(w=>w.includes('array not constraint omitted')));const val=compileOutputValidator(JSON.parse(JSON.stringify(m.tools[0]!.inputSchema)));assert.equal(val({v:[3,4]}),true);assert.equal(val({v:[3]}),false);
});
for(const counts of [{minContains:0},{minContains:2},{maxContains:2},{minContains:2,maxContains:2}])test(`unsupported contains counts omit complete positive and negative constraints ${JSON.stringify(counts)}`,async()=>{
 const source={type:'array',items:{type:'integer'},minItems:1,contains:{const:4},...counts,not:{contains:{const:4},...counts}};
 const doc:any={openapi:'3.1.0',info:{title:'Count gap',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',schema:source}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const m=buildManifest(doc);assert.ok(m.warnings?.some(w=>w.includes('array contains constraint omitted: contains-count constraints are not supported by the runtime validator')));assert.ok(m.warnings?.some(w=>w.includes('array not constraint omitted')));const val=compileOutputValidator(JSON.parse(JSON.stringify(m.tools[0]!.inputSchema)));assert.equal(val({v:[3]}),true);assert.equal(val({v:[4]}),true);assert.equal(val({v:[]}),false);
});
test('array shell conjuncts retain independent root and branch enums',async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Enums',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'cookie',schema:{type:'array',items:{type:'integer'},allOf:[{enum:[[3,4],[4,5]],format:'email'},{not:{enum:[[4,5]]}}]}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const t=buildManifest(doc).tools[0]!;const val=compileOutputValidator(JSON.parse(JSON.stringify(t.inputSchema)));assert.equal(val({v:[3,4]}),true);assert.equal(val({v:[4,5]}),false);assert.equal(val({v:[3,5]}),false);assert.equal(JSON.stringify(t.inputSchema).includes('email'),false);
});
