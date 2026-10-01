import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAPIV3 } from 'openapi-types';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { compileOutputValidator: (schema: unknown) => (value: unknown) => boolean };
test('oversize nullable parameter fallback retains root nullability', async () => {
 const doc = {openapi:'3.0.3',info:{title:'Nullable budget',version:'1'},components:{schemas:{}},paths:{'/':{get:{operationId:'get',parameters:[{name:'filter',in:'query',content:{'application/json':{schema:{type:'object',nullable:true,properties:Object.fromEntries(Array.from({length:300},(_,i)=>[`field${i}`,{type:'string'}]))}}}}],responses:{200:{description:'ok'}}}}}} as unknown as OpenAPIV3.Document;
 await init(doc); const tool=buildManifest(doc).tools[0]!;const validate=compileOutputValidator(tool.inputSchema);
 assert.equal(validate({filter:null}),true);assert.equal(validate({filter:{field1:'ok'}}),true);assert.equal(validate({filter:'wrong'}),false);
});

import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href) as { runHttpServer: (manifest: unknown, options: { port: number }) => Promise<Server> };
test('JSON content null reaches query, header and cookie as JSON, not omitted data', async () => {
 const seen: { url: string; header: string | undefined; cookie: string | undefined }[] = [];
 const api=createServer((req,res)=>{seen.push({url:req.url!,header:req.headers['x-filter'] as string|undefined,cookie:req.headers.cookie});res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
 await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));
 const schema={type:'object',nullable:true,properties:Object.fromEntries(Array.from({length:300},(_,i)=>[`field${i}`,{type:'string'}]))};
 const doc={openapi:'3.0.3',info:{title:'JSON null wire',version:'1'},components:{schemas:{}},servers:[{url:`http://127.0.0.1:${(api.address() as {port:number}).port}`}],paths:{'/':{get:{operationId:'get',parameters:[{name:'filter',in:'query'},{name:'x-filter',in:'header'},{name:'prefs',in:'cookie'}].map(p=>({...p,required:true,content:{'application/json':{schema}}})),responses:{200:{description:'ok'}}}}}} as unknown as OpenAPIV3.Document;
 let server:Server|undefined;const client=new Client({name:'json-null-wire',version:'1'});
 try{await init(doc);server=await runHttpServer(buildManifest(doc),{port:0});await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`)));
 const result=await client.callTool({name:'get',arguments:{filter:null,'x-filter':null,prefs:null}});assert.notEqual(result.isError,true);assert.equal(seen.length,1);assert.equal(new URL(seen[0]!.url,'http://local').searchParams.get('filter'),'null');assert.equal(JSON.parse(seen[0]!.header!),null);assert.equal(seen[0]!.cookie,'prefs=null');
 }finally{await client.close();if(server)await new Promise<void>(r=>server!.close(()=>r()));await new Promise<void>(r=>api.close(()=>r()));}
});
