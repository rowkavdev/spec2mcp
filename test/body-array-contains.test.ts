import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);

function doc31(extra: Record<string, unknown>) {
  return { openapi: '3.1.0', info: { title: 'Contains body', version: '1' }, components: { schemas: {} }, paths: {
    '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['tags'], properties: { tags: { type: 'array', items: { type: 'integer' }, minItems: 1, ...extra } },
    } } } }, responses: { '204': { description: 'ok' } } } },
  } } as any;
}

test('body array leaf retains plain contains',async()=>{const doc=doc31({contains:{const:4}});await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({tags:[3]}),false);assert.equal(val({tags:[4]}),true);});

test('body array leaf contains rejects before mock API', async () => {
  const { createServer } = await import('node:http');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
  const seen: string[] = [];
  const api = createServer((req, res) => { seen.push(req.url!); res.writeHead(204); res.end(); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const doc = doc31({ contains: { const: 4 } });
  let server: any; let client: any;
  try {
    await init(doc);
    server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as any).port}` }), { port: 0 });
    client = new Client({ name: 'probe', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    const badResult = await client.callTool({ name: 'post', arguments: { tags: [3] } });

    assert.equal(seen.length, 0);
    const good = await client.callTool({ name: 'post', arguments: { tags: [4] } });
    assert.equal(good.isError, undefined);
    assert.deepEqual(seen, ['/']);
  } finally {
    await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
    api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
  }
});
for(const version of ['3.1.0','3.1.1'])for(const loaded of [false,true])for(const ref of [false,true])for(const neg of [false,true])test(`${version} public=${loaded} ref=${ref} negative=${neg}`,async()=>{
 let doc=doc31(neg?{not:{$ref:'#/components/schemas/Check'}}:{contains:{$ref:'#/components/schemas/Match'}});doc.openapi=version;doc.components.schemas={Match:{const:4},Check:{contains:{$ref:'#/components/schemas/Match'}}};if(ref){doc.components.schemas.Arr=doc.paths['/'].post.requestBody.content['application/json'].schema.properties.tags;doc.paths['/'].post.requestBody.content['application/json'].schema.properties.tags={$ref:'#/components/schemas/Arr'};}
 if(loaded){const{loadSpec}=await import('../src/load.js');const{mkdtemp,writeFile,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const{join}=await import('node:path');const d=await mkdtemp(join(tmpdir(),'bodycontains-'));try{const p=join(d,'s.json');await writeFile(p,JSON.stringify(doc));doc=await loadSpec(p);}finally{await rm(d,{recursive:true,force:true});}}
 await init(doc);const m=buildManifest(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(m.tools[0]!.inputSchema)));assert.equal(val({tags:neg?[3]:[4]}),true);assert.equal(val({tags:neg?[4]:[3]}),false);assert.equal(val({}),false);assert.equal(val({tags:[]}),false);assert.equal(val({tags:['4']}),false);
});
for(const counts of [{minContains:0},{minContains:2},{maxContains:2},{minContains:2,maxContains:2}])for(const neg of [false,true])test(`count fallback ${JSON.stringify(counts)} negative=${neg}`,async()=>{
 const doc=doc31(neg?{not:{contains:{const:4},...counts}}:{contains:{const:4},...counts});await init(doc);const m=buildManifest(doc);assert.ok(m.warnings?.some((w:string)=>w.includes('contains-count constraints are not supported by the runtime validator')));const val=compileOutputValidator(JSON.parse(JSON.stringify(m.tools[0]!.inputSchema)));assert.equal(val({tags:[3]}),true);assert.equal(val({tags:[4]}),true);assert.equal(val({tags:[]}),false);assert.equal(val({}),false);
});
for(const kind of ['missing','cycle','budget'])for(const neg of [false,true])test(`${kind} negative=${neg} whole omission retains bounds`,async()=>{
 const check=kind==='budget'?{not:{const:'x'.repeat(100000)}}:{$ref:kind==='missing'?'#/components/schemas/Missing':'#/components/schemas/Loop'};const doc=doc31(neg?{not:check}:{contains:check});doc.components.schemas={Loop:{$ref:'#/components/schemas/Loop'}};await init(doc);const m=buildManifest(doc);assert.ok(m.warnings?.some((w:string)=>w.includes('constraint omitted')));const val=compileOutputValidator(JSON.parse(JSON.stringify(m.tools[0]!.inputSchema)));assert.equal(val({tags:[3]}),true);assert.equal(val({tags:[]}),false);assert.equal(val({tags:['3']}),false);
});
for(const version of ['3.0.3','3.1.0'])test(`${version} supported array negative bound`,async()=>{const doc=doc31({not:{minItems:2}});doc.openapi=version;await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({tags:[3]}),true);assert.equal(val({tags:[3,4]}),false);assert.equal(val({tags:[]}),false);});
test('nested dotted body names reconstruct exact JSON without dropping independent required fields',async()=>{
 const{createServer}=await import('node:http');const{Client}=await import('@modelcontextprotocol/sdk/client/index.js');const{StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');const{runHttpServer}=await import(new URL('../runtime/server.mjs',import.meta.url).href);const seen:string[]=[];const api=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push(body);res.writeHead(204);res.end();});await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));let client:any,server:any;
 const doc=doc31({});doc.paths['/'].post.requestBody.content['application/json'].schema={type:'object',required:['box','id'],properties:{id:{type:'integer'},box:{type:'object',required:['tags'],properties:{tags:{type:'array',items:{type:'integer'},minItems:1,contains:{const:4},not:{enum:[[4,4]]}}}}}};
 try{await init(doc);const m=buildManifest(doc,{baseUrl:`http://127.0.0.1:${(api.address()as any).port}`});server=await runHttpServer(m,{port:0});client=new Client({name:'wire',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));for(const args of [{'box.tags':[3],id:7},{'box.tags':[4,4],id:7},{'box.tags':[4]}])assert.equal((await client.callTool({name:'post',arguments:args})).isError,true);assert.deepEqual(seen,[]);assert.equal((await client.callTool({name:'post',arguments:{'box.tags':[3,4],id:7}})).isError,undefined);assert.equal(seen.length,1);assert.deepEqual(JSON.parse(seen[0]!),{box:{tags:[3,4]},id:7});}finally{await client?.close();server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(r));api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));}
});
test('nullable array leaf retains explicit null acceptance',async()=>{const doc=doc31({contains:{const:4},nullable:true});await init(doc);const val=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));assert.equal(val({tags:null}),true);assert.equal(val({}),false);assert.equal(val({tags:[3]}),false);assert.equal(val({tags:[4]}),true);});
