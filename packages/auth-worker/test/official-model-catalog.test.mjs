import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {readOfficialCatalog,handleAdminModels,adminCatalog,channelApiKey,validateChannel,validateModel,defaultCatalog} from '../src/official-model-catalog.js';
import {handleToChat} from '../src/tochat.js';

function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2);');
 for(const file of ['0003_subscriptions.sql','0004_quota_resets.sql','0008_model_access_trials.sql','0010_doubao_work.sql','0011_official_model_catalog.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 sqlite.prepare('INSERT INTO user_subscription VALUES(?,?,?,?,?,?,?)').run(1,'plus',Date.now()+86400000,500000000,1600000000,7000000000,Date.now());
 const db={prepare(sql){return{bind(...args){return{run(){return{meta:{changes:sqlite.prepare(sql).run(...args).changes}};},first(){return sqlite.prepare(sql).get(...args)||null;},all(){return{results:sqlite.prepare(sql).all(...args)};}};}};},async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB:db,DEEPSEEK_API_KEY:'existing-synthetic-key',MODEL_CATALOG_ENCRYPTION_KEY:randomBytes(32).toString('base64'),TURNSTILE_DEV_BYPASS:'1'},tasks=[],ctx={waitUntil(p){tasks.push(p);}};
 return {sqlite,env,ctx,tasks};
}
const admin=(env,path,method,body)=>handleAdminModels(new Request('https://test/admin/'+path,{method,body:body?JSON.stringify(body):undefined}),env);
async function edit(env,path,method,body){const catalog=await readOfficialCatalog(env);return admin(env,path,method,{...body,revision:catalog.revision});}
const request=(id,tag,mode='work',feature='tocode',extra={})=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':mode,'x-tora-feature':feature,'x-tochat-message-id':tag,'x-tochat-request-id':tag+'-request'},body:JSON.stringify({model:id,messages:[{role:'user',content:'Inspect fixture'}],max_tokens:256,...extra})});
const completion=()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'REMOTE_OK'},finish_reason:'stop'}],usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:20},completion_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const newModel=catalog=>({...catalog.models.find(model=>model.id==='deepseek-flash'),id:'remote-demo',name:'远程模型',upstreamModel:'upstream-version',efforts:['low','high'],modes:['chat','work','tocode'],minimumPlan:'plus',rates:{input:10,cached:2,output:20}});

test('catalog seeds existing defaults once, supports CRUD and optimistic revisions without losing concurrent edits',async()=>{
 const f=fixture();try{
  const original=await readOfficialCatalog(f.env);assert.deepEqual(original.models,defaultCatalog().models);
  const response=await admin(f.env,'official-models','POST',{...newModel(original),revision:original.revision});assert.equal(response.status,200);
  assert.equal((await admin(f.env,'official-models/remote-demo','PATCH',{revision:original.revision,name:'stale'})).status,409);
  const snapshot=await readOfficialCatalog(f.env),results=await Promise.all(['A','B'].map(name=>admin(f.env,'official-models/remote-demo','PATCH',{revision:snapshot.revision,name})));
  assert.deepEqual(results.map(response=>response.status).sort(),[200,409]);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM official_catalog_audit').get().n,2);
  assert.equal((await edit(f.env,'official-models/remote-demo','DELETE',{})).status,200);
  const quota=await(await handleToChat(new Request('https://test/tochat/quota'),f.env,f.ctx,{id:1})).json();assert.ok(!quota.models.some(model=>model.id==='remote-demo'));
  assert.equal((await edit(f.env,'official-models/remote-demo','PATCH',{enabled:true})).status,200);
  assert.equal((await readOfficialCatalog(f.env)).models.find(model=>model.id==='remote-demo').deleted,undefined);
 }finally{f.sqlite.close();}
});
test('API keys encrypt at rest, remain write-only, cannot reuse managed keys at changed endpoints and never leak in audit/public metadata',async()=>{
 const f=fixture();try{
  const secret='synthetic-custom-secret';
  const response=await edit(f.env,'model-channels','POST',{id:'custom-api',name:'新渠道',url:'https://provider.example.com/v1/chat/completions',protocol:'chat',adapter:'openai',enabled:true,apiKey:secret});assert.equal(response.status,200);
  const data=await response.json();assert.ok(!JSON.stringify(data).includes(secret));assert.ok(!JSON.stringify(data).includes('keyCipher'));assert.equal(data.channels.find(channel=>channel.id==='custom-api').keySet,true);
  const stored=f.sqlite.prepare('SELECT document FROM official_model_catalog').get().document;assert.ok(!stored.includes(secret));const channel=(await readOfficialCatalog(f.env)).channels.find(channel=>channel.id==='custom-api');assert.equal(await channelApiKey(f.env,channel),secret);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM official_catalog_audit').all()).includes(secret));
  assert.equal((await edit(f.env,'model-channels/custom-api','PATCH',{name:'改名',apiKey:''})).status,200);assert.equal(await channelApiKey(f.env,(await readOfficialCatalog(f.env)).channels.find(channel=>channel.id==='custom-api')),secret);
  assert.equal((await edit(f.env,'model-channels/deepseek_api_key','PATCH',{url:'https://different.example.com/v1/chat/completions'})).status,422);
  const model={...newModel(await readOfficialCatalog(f.env)),channelId:'custom-api'};assert.equal((await edit(f.env,'official-models','POST',model)).status,200);
  assert.equal((await edit(f.env,'model-channels/custom-api','DELETE',{})).status,409);
  const quota=await(await handleToChat(new Request('https://test/tochat/quota'),f.env,f.ctx,{id:1})).json();assert.ok(!JSON.stringify(quota).includes(secret));assert.ok(!JSON.stringify(quota).includes('provider.example.com'));
  await assert.rejects(()=>channelApiKey({...f.env,MODEL_CATALOG_ENCRYPTION_KEY:randomBytes(32).toString('base64')},channel),/密钥/);
 }finally{f.sqlite.close();}
});
test('remote permissions and mode changes immediately gate requests, with no upstream calls on denied or deleted models',async()=>{
 const f=fixture(),before=globalThis.fetch;let calls=0;try{
  globalThis.fetch=async()=>{calls++;return completion();};
  assert.equal((await edit(f.env,'official-models','POST',newModel(await readOfficialCatalog(f.env)))).status,200);
  const response=await handleToChat(request('remote-demo','remote-allowed'),f.env,f.ctx,{id:1});assert.equal(response.status,200);await response.text();await Promise.all(f.tasks);
  assert.equal((await edit(f.env,'official-models/remote-demo','PATCH',{minimumPlan:'max5'})).status,200);
  const denied=await handleToChat(request('remote-demo','remote-denied'),f.env,f.ctx,{id:1});assert.equal(denied.status,403);assert.equal((await denied.json()).requiredPlan,'max5');assert.equal(calls,1);
  assert.equal((await edit(f.env,'official-models/remote-demo','PATCH',{minimumPlan:null,modes:['chat']})).status,200);
  assert.equal((await handleToChat(request('remote-demo','remote-mode'),f.env,f.ctx,{id:1})).status,403);assert.equal(calls,1);
  const free=await handleToChat(request('remote-demo','remote-chat','chat','tochat'),f.env,f.ctx,{id:2});assert.equal(free.status,200);await free.text();await Promise.all(f.tasks);
  assert.equal((await edit(f.env,'official-models/remote-demo','DELETE',{})).status,200);
  assert.equal((await handleToChat(request('remote-demo','remote-deleted'),f.env,f.ctx,{id:1})).status,400);assert.equal(calls,2);
 }finally{globalThis.fetch=before;f.sqlite.close();}
});
test('in-flight requests settle at their pinned prices; next calls use new Credits and route IDs without fallback',async()=>{
 const f=fixture(),before=globalThis.fetch;try{
  await edit(f.env,'official-models','POST',newModel(await readOfficialCatalog(f.env)));
  let first=true;
  globalThis.fetch=async(url,init)=>{
   assert.equal(url,'https://api.deepseek.com/v1/chat/completions');assert.equal(JSON.parse(init.body).model,'upstream-version');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer existing-synthetic-key');
   if(first){first=false;assert.equal((await edit(f.env,'official-models/remote-demo','PATCH',{rates:{input:100,cached:20,output:200}})).status,200);}
   return completion();
  };
  for(const tag of ['price-first','price-next']){const response=await handleToChat(request('remote-demo',tag),f.env,f.ctx,{id:1});assert.equal(response.status,200);await response.text();await Promise.all(f.tasks);}
  const usages=f.sqlite.prepare('SELECT credit_micro FROM usage_log ORDER BY rowid').all();assert.deepEqual(usages.map(row=>row.credit_micro),[1040,10400]);
  const snapshots=f.sqlite.prepare('SELECT * FROM official_request_prices ORDER BY created_at').all();assert.equal(JSON.parse(snapshots[0].rates).input,10);assert.equal(JSON.parse(snapshots[1].rates).input,100);assert.ok(snapshots[1].catalog_revision>snapshots[0].catalog_revision);
 }finally{globalThis.fetch=before;f.sqlite.close();}
});
test('validation rejects unsafe endpoints, malformed pricing, incompatible multimedia and credential injection',async()=>{
 const f=fixture();try{
  const catalog=await readOfficialCatalog(f.env),model=newModel(catalog);
  for(const url of ['http://public.example/v1','https://127.0.0.1/v1','https://[::1]/v1','https://user:secret@example.com/v1','https://example.com/v1?api_key=secret','https://example.local/v1'])assert.throws(()=>validateChannel({id:'test',name:'test',url,protocol:'chat',adapter:'openai',enabled:true}));
  for(const rates of [{input:0,cached:1,output:1},{input:-1,cached:1,output:1},{input:1.2,cached:1,output:1},{input:1,cached:1,output:1,longInput:2}])assert.throws(()=>validateModel({...model,rates},catalog.channels));
  assert.throws(()=>validateModel({...model,inputModalities:['text','audio']},catalog.channels),/方舟/);
  const invalid=await edit(f.env,'model-channels','POST',{id:'injected',name:'test',url:'https://example.com/v1',protocol:'chat',adapter:'openai',enabled:true,secretRef:'ADMIN_TOKEN'});assert.equal(invalid.status,422);
  const count=f.sqlite.prepare('SELECT COUNT(*) n FROM official_catalog_audit').get().n;assert.equal(count,0);
  assert.ok(adminCatalog(catalog,f.env).encryptionReady);
 }finally{f.sqlite.close();}
});
test('a remotely added Responses model uses the selected adapter and can omit reasoning configuration',async()=>{
 const f=fixture(),before=globalThis.fetch;try{
  assert.equal((await edit(f.env,'model-channels','POST',{id:'remote-response-channel',name:'Responses 渠道',url:'https://provider.example.com/v1/responses',protocol:'responses',adapter:'openai',enabled:true,apiKey:'synthetic-response-key'})).status,200);
  const model={...newModel(await readOfficialCatalog(f.env)),channelId:'remote-response-channel',efforts:['low'],effortParameter:'none'};
  assert.equal((await edit(f.env,'official-models','POST',model)).status,200);
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);assert.equal(body.model,'upstream-version');assert.equal(body.reasoning,undefined);assert.ok(Array.isArray(body.input));assert.equal(init.headers.authorization,'Bearer synthetic-response-key');return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'REMOTE_RESPONSES_OK'}]}],usage:{input_tokens:100,input_tokens_details:{cached_tokens:20},output_tokens:10}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
  const response=await handleToChat(request(model.id,'remote-response-test'),f.env,f.ctx,{id:1});assert.equal(response.status,200);assert.match(await response.text(),/REMOTE_RESPONSES_OK/);await Promise.all(f.tasks);
  assert.equal(f.sqlite.prepare('SELECT credit_micro FROM usage_log').get().credit_micro,1040);
 }finally{globalThis.fetch=before;f.sqlite.close();}
});
test('custom cache prices higher than text receive a sufficient reservation and settle at the configured rate',async()=>{
 const f=fixture(),before=globalThis.fetch;try{
  const model={...newModel(await readOfficialCatalog(f.env)),rates:{input:10,cached:100000,output:20}};
  await edit(f.env,'official-models','POST',model);globalThis.fetch=async()=>completion();
  const response=await handleToChat(request(model.id,'high-cache-price'),f.env,f.ctx,{id:1});assert.equal(response.status,200);await response.text();await Promise.all(f.tasks);
  assert.equal(f.sqlite.prepare('SELECT credit_micro FROM usage_log').get().credit_micro,2001000);
 }finally{globalThis.fetch=before;f.sqlite.close();}
});
