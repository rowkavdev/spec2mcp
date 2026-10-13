import {test} from 'node:test';
import assert from 'node:assert/strict';
import {init} from '../vendor/forge/index.js';
import {buildManifest} from '../src/manifest.js';
const {compileOutputValidator}=await import(new URL('../runtime/server.mjs',import.meta.url).href);
for(const version of ['3.0.3','3.1.0'])for(const location of ['query','header','cookie','path'])test(`${version} ${location} scalar root exclusion`,async()=>{
 const source={type:'integer',not:{enum:[4]}};const doc:any={openapi:version,info:{title:'Root exclusion',version:'1'},components:{schemas:{}},paths:{[location==='path'?'/x/{v}':'/x']:{get:{operationId:'get',parameters:[{name:'v',in:location,required:true,schema:source}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;const validate=compileOutputValidator(tool.inputSchema);assert.equal(validate({v:3}),true);assert.equal(validate({v:4}),false);
});
test('scalar root exclusion blocks HTTP',async()=>{
 const {createServer}=await import('node:http');const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');const {runHttpServer}=await import(new URL('../runtime/server.mjs',import.meta.url).href);
 const seen:string[]=[];const api=createServer((req,res)=>{seen.push(req.url!);res.writeHead(204);res.end();});await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));
 const source={type:'integer',not:{enum:[4]}};assert.equal(compileOutputValidator(source)(4),false);
 const doc:any={openapi:'3.1.0',info:{title:'Root exclusion',version:'1'},components:{schemas:{}},paths:{'/x':{get:{operationId:'get',parameters:[{name:'v',in:'query',required:true,schema:source}],responses:{'204':{description:'ok'}}}}}};let server:any,client:any;
 try{await init(doc);server=await runHttpServer(buildManifest(doc,{baseUrl:`http://127.0.0.1:${(api.address() as any).port}`}),{port:0});client=new Client({name:'probe',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));const result=await client.callTool({name:'get',arguments:{v:4}});assert.equal(seen.length,0);assert.equal(result.isError,true);const good=await client.callTool({name:'get',arguments:{v:3}});assert.equal(good.isError,undefined);assert.deepEqual(seen,['/x?v=3']);}
 finally{await client?.close();server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(r));api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));}
});
for(const version of ['3.0.3','3.1.0','3.1.1'])for(const location of ['path','query','header','cookie'])for(const loaded of [false,true])test(`${version} ${location} public=${loaded} scalar root referenced negative`,async()=>{
 let doc:any={openapi:version,info:{title:'Root',version:'1'},components:{schemas:{Excluded:{enum:[4]},Value:{type:'integer',minimum:2,maximum:6,not:{$ref:'#/components/schemas/Excluded'}}}},paths:{[location==='path'?'/x/{v}':'/x']:{get:{operationId:'get',parameters:[{name:'v',in:location,required:true,schema:{$ref:'#/components/schemas/Value'}}],responses:{'204':{description:'ok'}}}}}};
 if(loaded){const{loadSpec}=await import('../src/load.js');const{mkdtemp,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const d=await mkdtemp(join(tmpdir(),'scalar-not-'));try{const p=join(d,'s.json');await writeFile(p,JSON.stringify(doc));doc=await loadSpec(p);}finally{await rm(d,{recursive:true,force:true});}}
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({v:3}),true);for(const n of [4,1,7,2.5])assert.equal(val({v:n}),false);
});
for(const [kind,not,schemas]of [['budget',{not:{const:'x'.repeat(100000)}},{}],['missing',{$ref:'#/components/schemas/Missing'},{}],['cycle',{$ref:'#/components/schemas/Loop'},{Loop:{$ref:'#/components/schemas/Loop'}}]]as any[])test(`${kind} root negative omitted whole preserves positive bounds`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Fallback',version:'1'},components:{schemas},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',schema:{type:'integer',minimum:2,maximum:5,not}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const m=buildManifest(doc);assert.ok(m.warnings?.some(w=>w.includes('root not constraint omitted')));const val=compileOutputValidator(JSON.parse(JSON.stringify(m.tools[0]!.inputSchema)));assert.equal(val({v:3}),true);assert.equal(val({v:1}),false);assert.equal(val({v:6}),false);
});
for(const version of ['3.0.3','3.1.0'])test(`${version} root negative ref siblings`,async()=>{
 const doc:any={openapi:version,info:{title:'Sibling',version:'1'},components:{schemas:{Excluded:{minimum:2}}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',schema:{type:'integer',not:{$ref:'#/components/schemas/Excluded',maximum:5}}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({v:1}),true);assert.equal(val({v:3}),false);assert.equal(val({v:9}),version==='3.1.0');
});
for(const location of ['path','query','header','cookie'])test(`${location} root plus branch negative stays conjunctive`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Conjunction',version:'1'},components:{schemas:{}},paths:{[location==='path'?'/x/{v}':'/x']:{get:{operationId:'get',parameters:[{name:'v',in:location,schema:{type:'integer',nullable:true,default:3,enum:[3,4,5],not:{enum:[4]},allOf:[{type:'integer',not:{enum:[5]}}]}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({v:3}),true);assert.equal(val({v:4}),false);assert.equal(val({v:5}),false);
});
for(const [type,good,bad]of [['string','safe','bad'],['number',3.5,4.5],['boolean',true,false]]as const)test(`${type} root negative`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'Type',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'cookie',schema:{type,not:{enum:[bad]}}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({v:good}),true);assert.equal(val({v:bad}),false);
});
for(const not of [JSON.parse('{"if":{"minimum":2},"then":{"maximum":5}}'),{contains:{const:4},minContains:0}])test(`root not held/unsupported subtree whole omission ${JSON.stringify(not)}`,async()=>{
 const doc:any={openapi:'3.1.0',info:{title:'No policy change',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'v',in:'query',schema:{type:'integer',minimum:2,not}}],responses:{'204':{description:'ok'}}}}}};
 await init(doc);const m=buildManifest(doc);assert.ok(m.warnings?.some(w=>w.includes('root not constraint omitted')));const val=compileOutputValidator(JSON.parse(JSON.stringify(m.tools[0]!.inputSchema)));assert.equal(val({v:3}),true);assert.equal(val({v:1}),false);
});
