import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { init } from '../vendor/forge/index.js';
import { loadSpec } from '../src/load.js';
import { buildManifest } from '../src/manifest.js';

test('remote root server resolves against its serving document', async () => {
  const doc = { openapi: '3.0.3', info: { title: 'RelativeRemote', version: '1' }, servers: [{ url: '/v2' }], paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } } } };
  const source = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/spec.json') res.end(JSON.stringify(doc));
    else if (req.url === '/v2/ping') res.end(JSON.stringify({ ok: true }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(r => source.listen(0, '127.0.0.1', r));
  try {
    const addr = source.address() as { port: number };
    const origin = `http://127.0.0.1:${addr.port}`;
    const loaded = await loadSpec(`${origin}/spec.json`);
    await init(loaded);
    const manifest = buildManifest(loaded);
    assert.equal(manifest.baseUrl, `${origin}/v2`);
  } finally {
    source.closeAllConnections();
    await new Promise<void>(r => source.close(() => r()));
  }
});

for(const version of ['3.0.3','3.1.0','3.1.1'])test(`${version} redirected root/inline scoped servers use final document path and defaults`,async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const{StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');const{runHttpServer}=await import(new URL('../runtime/server.mjs',import.meta.url).href);const seen:string[]=[];
 const doc:any={openapi:version,info:{title:'Serving',version:'1'},servers:[{url:'../{version}',variables:{version:{default:'v2'}}}],components:{schemas:{},pathItems:{Unproven:{servers:[{url:'/unproven'}],get:{operationId:'unproven',responses:{'204':{description:'ok'}}}}}},paths:{'/root':{get:{operationId:'root',responses:{'204':{description:'ok'}}}},'/path':{servers:[{url:'./path-base'}],get:{operationId:'path',responses:{'204':{description:'ok'}}}},'/op':{servers:[{url:'/wrong'}],get:{operationId:'op',servers:[{url:'/operation'}],responses:{'204':{description:'ok'}}}},'/unproven':{$ref:'#/components/pathItems/Unproven'}}};
 const source=createServer((req,res)=>{if(req.url==='/entry'){res.writeHead(302,{Location:'/specs/final.json'});res.end();}else if(req.url==='/specs/final.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(doc));}else{seen.push(req.url!);res.writeHead(204);res.end();}});await new Promise<void>(r=>source.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(source.address()as any).port}`;let server:any,client:any;const env='SERVING_BASE_URL';const old=process.env[env];
 try{const loaded=await loadSpec(origin+'/entry');await init(loaded);const m=buildManifest(loaded);assert.equal(m.baseUrl,origin+'/v2');assert.equal(m.tools.find(t=>t.name==='path')?.baseUrl,origin+'/specs/path-base');assert.equal(m.tools.find(t=>t.name==='op')?.baseUrl,origin+'/operation');assert.equal(m.tools.find(t=>t.name==='unproven')?.baseUrl,'/unproven');const explicit=buildManifest(loaded,{baseUrl:origin+'/explicit'});assert.equal(explicit.baseUrl,origin+'/explicit');assert.ok(explicit.tools.every(t=>t.baseUrl===undefined));
 server=await runHttpServer(m,{port:0});client=new Client({name:'origin-controls',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));for(const name of ['root','path','op'])assert.equal((await client.callTool({name,arguments:{}})).isError,undefined);assert.deepEqual(seen,['/v2/root','/specs/path-base/path','/operation/op']);const invalid=await client.callTool({name:'unproven',arguments:{}});assert.equal(invalid.isError,true);assert.equal(seen.length,3);process.env[env]=origin+'/env';assert.equal((await client.callTool({name:'op',arguments:{}})).isError,undefined);assert.equal(seen[3],'/env/op');
 const clone=structuredClone(loaded);await init(clone);assert.equal(buildManifest(clone).baseUrl,'../{version}'.replace('{version}','v2'));loaded.servers![0]!.url='/overlay-introduced';await init(loaded);assert.equal(buildManifest(loaded).baseUrl,'/overlay-introduced');
 }finally{if(old===undefined)delete process.env[env];else process.env[env]=old;await client?.close();server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(r));source.closeAllConnections();await new Promise<void>(r=>source.close(()=>r()));}
});

test('local file/in-memory and bundled external path servers never gain an invented origin',async()=>{
 const{mkdtemp,writeFile,rm}=await import('node:fs/promises');const{join}=await import('node:path');const{tmpdir}=await import('node:os');const d=await mkdtemp(join(tmpdir(),'server-origin-'));
 const doc:any={openapi:'3.1.0',info:{title:'No HTTP origin',version:'1'},servers:[{url:'/v2'}],components:{schemas:{}},paths:{'/external':{$ref:'./external.json'}}};
 try{await writeFile(join(d,'root.json'),JSON.stringify(doc));await writeFile(join(d,'external.json'),JSON.stringify({servers:[{url:'../external-api'}],get:{operationId:'external',responses:{'204':{description:'ok'}}}}));const loaded=await loadSpec(join(d,'root.json'));await init(loaded);const m=buildManifest(loaded);assert.equal(m.baseUrl,'/v2');assert.equal(m.tools[0]!.baseUrl,'../external-api');const simple={...doc,paths:{'/x':{get:{operationId:'x',responses:{'204':{description:'ok'}}}}}};await init(simple);assert.equal(buildManifest(simple).baseUrl,'/v2');assert.equal(buildManifest(simple,{baseUrl:'https://explicit.example/v3'}).baseUrl,'https://explicit.example/v3');}finally{await rm(d,{recursive:true,force:true});}
});
for(const template of ['/v2','./api','../api','//api.example.test/v2','https://absolute.example/v2'])test(`relative/absolute template ${template}`,async()=>{
 const source=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({openapi:'3.1.0',info:{title:'Template',version:'1'},servers:[{url:template}],paths:{'/x':{get:{operationId:'x',responses:{'204':{description:'ok'}}}}}}));});await new Promise<void>(r=>source.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(source.address()as any).port}/specs/root.json`;
 try{const loaded=await loadSpec(url);await init(loaded);assert.equal(buildManifest(loaded).baseUrl,new URL(template,url).href);}finally{source.closeAllConnections();await new Promise<void>(r=>source.close(()=>r()));}
});
