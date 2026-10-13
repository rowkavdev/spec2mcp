import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../vendor/forge/index.js';
import { buildManifest } from '../src/manifest.js';
const { compileOutputValidator } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
test('body allOf intersects repeated property constraints', async () => {
 const doc: any = { openapi: '3.0.3', info: { title: 'Intersection', version: '1' }, components: { schemas: {} }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], allOf: [ { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 5 } } }, { type: 'object', properties: { name: { type: 'string', maxLength: 10 } } } ] } } } }, responses: { '204': { description: 'ok' } } } } } };
 await init(doc);
 const tool = buildManifest(doc).tools[0]!;
 const validate = compileOutputValidator(tool.inputSchema);
 assert.equal(validate({name: 'valid'}), true);
 assert.equal(validate({name: 'x'}), false);
});

test('body allOf rejects a too-short name before mock API', async () => {
 const { createServer } = await import('node:http');
 const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
 const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const { runHttpServer } = await import(new URL('../runtime/server.mjs', import.meta.url).href);
 const seen: string[] = [];
 const api = createServer((req, res) => { seen.push(req.url!); res.writeHead(204); res.end(); });
 await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
 const doc: any = { openapi: '3.0.3', info: { title: 'Intersection', version: '1' }, components: { schemas: {} }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], allOf: [ { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 5 } } }, { type: 'object', properties: { name: { type: 'string', maxLength: 10 } } } ] } } } }, responses: { '204': { description: 'ok' } } } } } };
 let server: any; let client: any;
 try {
  await init(doc); server = await runHttpServer(buildManifest(doc, { baseUrl: `http://127.0.0.1:${(api.address() as any).port}` }), { port: 0 });
  client = new Client({ name: 'boolean-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  const result = await client.callTool({ name: 'post', arguments: { name: 'x' } });
  assert.equal(seen.length, 0);
 } finally {
  await client?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(r => server.close(r));
  api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
 }
});

for (const version of ['3.0.3', '3.1.0', '3.1.1']) for (const references of [false, true]) for (const nested of [false, true]) for (const rootContribution of [false, true]) for (const reverse of [false, true]) {
 test(`${version} ref=${references} nested=${nested} root=${rootContribution} reverse=${reverse} property intersections`, async () => {
  const low = { type: 'string', minLength: 5, description: 'First note' };
  const high = { type: 'string', maxLength: 10, default: 'valid', description: 'Last note' };
  const property = (schema: any) => nested ? { type: 'object', required: ['name'], properties: { name: schema } } : schema;
  const field = nested ? 'pet' : 'name';
  const min = { type: 'object', properties: { [field]: property(references ? { $ref: '#/components/schemas/Low' } : low) } };
  const max = { type: 'object', properties: { [field]: property(high) } };
  let branches: any[] = references ? [{ $ref: '#/components/schemas/Min' }, { $ref: '#/components/schemas/Max' }] : [min, max];
  if (reverse) branches.reverse();
  const root: any = { type: 'object', required: [field], allOf: rootContribution ? branches.slice(0,1) : branches };
  if (rootContribution) root.properties = (reverse ? min : max).properties;
  const doc: any = { openapi: version, info: { title: 'Body intersections', version: '1' }, components: { schemas: { Low: low, Min: min, Max: max, Root: root } }, paths: { '/': { post: { operationId: 'post', requestBody: { required: true, content: { 'application/json': { schema: references ? { $ref: '#/components/schemas/Root' } : root } } }, responses: { '204': { description: 'ok' } } } } } };
  await init(doc);
  const tool = buildManifest(doc).tools[0]!;
  assert.deepEqual(tool.args.map(a => a.name), [nested ? 'pet.name' : 'name']);
  const validate = compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  const input = (name: string) => ({ [nested ? 'pet.name' : 'name']: name });
  assert.equal(validate(input('valid')), true);
  assert.equal(validate(input('x')), false);
  assert.equal(validate(input('longlonglong')), false);
 });
}

for (const version of ['3.0.3', '3.1.0']) for (const [label, left, right, good, bad] of [
 ['nullable intersection', { type:'string', nullable:true, minLength:3 }, { type:'string', nullable:true, maxLength:5 }, [null,'good'], ['x','toolong']],
 ['nonnullable intersection', { type:'string', minLength:3 }, { type:'string', nullable:true, maxLength:5 }, ['good'], [null,'x','toolong']],
 ['enum intersection', { type:'integer', enum:[1,2], minimum:1 }, { type:'integer', enum:[2,3], default:2 }, [2], [1,3,2.5]],
 ['array intersections', { type:'array', minItems:2, items:{type:'integer',minimum:2} }, { type:'array', maxItems:3, items:{type:'integer',maximum:5} }, [[2,3]], [[2],[1,3],[2,6],[2,3,4,5]]],
] as any[]) {
 test(`${version} repeated body ${label}`, async () => {
  const doc:any={openapi:version,info:{title:'Property controls',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['value'],allOf:[{type:'object',properties:{value:left}},{type:'object',properties:{value:right}}]}}}},responses:{'204':{description:'ok'}}}}}};
  await init(doc);const tool=buildManifest(doc).tools[0]!;
  const validate=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
  for(const value of good) assert.equal(validate({value}),true);
  for(const value of bad) assert.equal(validate({value}),false);
 });
}

for(const version of ['3.0.3','3.1.0','3.1.1']) test(`${version} body property ref-hop contributions follow version semantics`,async()=>{
 const doc:any={openapi:version,info:{title:'Ref shell',version:'1'},components:{schemas:{Root:{type:'object',required:['name'],properties:{name:{type:'string',minLength:5}}}}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Root',properties:{name:{type:'string',maxLength:10}}}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const validate=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
 assert.equal(validate({name:'valid'}),true);assert.equal(validate({name:'x'}),false);assert.equal(validate({name:'longlonglong'}),version==='3.0.3');
});
for(const version of ['3.0.3','3.1.0']) test(`${version} oversized repeated property warns without partial negative mapping`,async()=>{
 const doc:any={openapi:version,info:{title:'Budget',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['name'],allOf:[{type:'object',properties:{name:{type:'string',not:{const:'x'.repeat(100000)}}}},{type:'object',properties:{name:{type:'string',description:'Note',default:'valid'}}}]}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const manifest=buildManifest(doc);const arg=manifest.tools[0]!.args[0]!;
 assert.equal(arg.name,'name');assert.equal(arg.schema.description,'Note');assert.equal(arg.schema.default,'valid');assert.ok(manifest.warnings?.some(w=>w.includes('property intersection constraints omitted')));
 assert.equal(compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)))({name:'valid'}),true);
});

for(const version of ['3.0.3','3.1.0']) for(const media of ['application/json','application/problem+json']) test(`${version} ${media} whole body intersection fallback remains intact`,async()=>{
 const doc:any={openapi:version,info:{title:'Whole body',version:'1'},components:{schemas:{}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{[media]:{schema:{type:'object',allOf:[{type:'object',required:['name'],properties:{name:{type:'string',minLength:5}}},{type:'object',properties:{name:{type:'string',maxLength:10}}}]}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const tool=buildManifest(doc).tools[0]!;assert.deepEqual(tool.args.map(a=>a.name),['body']);const validate=compileOutputValidator(JSON.parse(JSON.stringify(tool.inputSchema)));
 assert.equal(validate({body:{name:'valid'}}),true);assert.equal(validate({body:{name:'x'}}),false);assert.equal(validate({body:{name:'longlonglong'}}),false);
});

for(const version of ['3.0.3','3.1.0']) test(`${version} repeated reference DAG retains distinct constraints without expansion`,async()=>{
 const schemas:any={Base:{type:'object',properties:{name:{type:'string',minLength:5}}}};
 for(let i=1;i<=5;i++) schemas[`Level${i}`]={type:'object',allOf:Array.from({length:10},()=>({$ref:`#/components/schemas/${i===1?'Base':`Level${i-1}`}`}))};
 const doc:any={openapi:version,info:{title:'DAG',version:'1'},components:{schemas},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['name'],allOf:[{$ref:'#/components/schemas/Level5'},{type:'object',properties:{name:{type:'string',maxLength:10}}}]}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const manifest=buildManifest(doc);const validate=compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)));
 assert.equal(validate({name:'valid'}),true);assert.equal(validate({name:'x'}),false);assert.equal(validate({name:'longlonglong'}),false);
 assert.equal(manifest.warnings?.some(w=>w.includes('property intersection constraints omitted'))??false,false);
 assert.ok(JSON.stringify(manifest.tools[0]!.inputSchema).length<1000);
});

for(const version of ['3.0.3','3.1.0']) test(`${version} distinct ref shell siblings remain separate property conjuncts`,async()=>{
 const doc:any={openapi:version,info:{title:'Shells',version:'1'},components:{schemas:{Name:{type:'string'}}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['name'],allOf:[{type:'object',properties:{name:{$ref:'#/components/schemas/Name',minLength:5}}},{type:'object',properties:{name:{$ref:'#/components/schemas/Name',maxLength:10}}}]}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const validate=compileOutputValidator(JSON.parse(JSON.stringify(buildManifest(doc).tools[0]!.inputSchema)));
 assert.equal(validate({name:'valid'}),true);assert.equal(validate({name:'x'}),version==='3.0.3');assert.equal(validate({name:'longlonglong'}),version==='3.0.3');
});
for(const kind of ['visits','contributions']) test(`body intersection ${kind} budget gives one clean warning`,async()=>{
 const count=kind==='visits'?4200:140;
 const branch=()=>({type:'object',properties:{name:{type:'string'}}});
 const doc:any={openapi:'3.1.0',info:{title:'Traversal budget',version:'1'},components:{schemas:{Empty:{type:'object'}}},paths:{'/':{post:{operationId:'post',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['name'],allOf:[...Array.from({length:count},()=>kind==='visits'?{$ref:'#/components/schemas/Empty'}:branch()),branch()]}}}},responses:{'204':{description:'ok'}}}}}};
 await init(doc);const manifest=buildManifest(doc);assert.equal(manifest.warnings?.filter(w=>w.includes('property intersection constraints omitted')).length,1);assert.equal(compileOutputValidator(JSON.parse(JSON.stringify(manifest.tools[0]!.inputSchema)))({name:'valid'}),true);
});
