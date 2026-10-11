import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const fixtureDir=mkdtempSync(join(tmpdir(),'tora-remote-catalog-'));process.env.TORA_HOME=fixtureDir;
const {startASAPIServer}=await import('../src/asapi/server.js');
const {resolveRunCfg}=await import('../src/asapi/bridge.js');
const originalFetch=globalThis.fetch,server=await startASAPIServer({port:0}),base='http://127.0.0.1:'+server.address().port;
const headers={'content-type':'application/json'};
const configure=token=>originalFetch(base+'/admin/tochat-config',{method:'POST',headers,body:JSON.stringify({baseURL:'https://official.example',authToken:token})});
const model={id:'remote-brand-new',name:'远程模型名称',provider:'custom',enabled:true,allowed:true,context:250000,maxOutput:8192,efforts:['low'],input_modalities:['text'],modes:['chat','work','tocode']};
try{
 test('quota hydrates new models, live labels and full context into local runtime; deletion does not borrow personal models',async()=>{
  await configure('synthetic-account');
  globalThis.fetch=async()=>Response.json({catalogRevision:2,models:[model]});
  const response=await originalFetch(base+'/admin/tochat-quota');assert.equal(response.status,200);
  const credentials=await(await originalFetch(base+'/credential/')).json();assert.equal(credentials.credentials.find(item=>item.id==='tora-official').data.model_providers[model.id],'custom');
  const cards=await(await originalFetch(base+'/model/?provider=tora_official')).json();assert.deepEqual(cards.models.map(item=>item.name),[model.id]);assert.equal(cards.models[0].label,model.name);assert.equal(cards.models[0].context_size,250000);assert.deepEqual(cards.models[0].input_types,['text']);
  const session={config:{application_mode:'tocode',chat_model_config:{credential_id:'tora-official',model:model.id,parameters:{contextSize:2048,thinkingEffort:'high'}}}};
  const cfg=resolveRunCfg(session,{});assert.equal(cfg.model,model.id);assert.equal(cfg.apiKey,'synthetic-account');assert.equal(cfg.maxTokensBudget,250000-8192-8192);assert.equal(cfg.thinkingEffort,'low');
  globalThis.fetch=async()=>Response.json({catalogRevision:3,models:[]});assert.equal((await originalFetch(base+'/admin/tochat-quota')).status,200);
  assert.equal((await(await originalFetch(base+'/model/?provider=tora_official')).json()).models.length,0);assert.throws(()=>resolveRunCfg(session,{}),/不支持/);
  globalThis.fetch=async()=>Response.json({catalogRevision:2,models:[model]});await originalFetch(base+'/admin/tochat-quota');
  assert.equal((await(await originalFetch(base+'/model/?provider=tora_official')).json()).models.length,0,'late older catalog must not resurrect a deleted model');
  await configure('');
 });
 test('mode restrictions and failed fetches preserve a safe last catalog; account changes clear it',async()=>{
  await configure('synthetic-account-two');globalThis.fetch=async()=>Response.json({catalogRevision:4,models:[{...model,modes:['chat']}]});await originalFetch(base+'/admin/tochat-quota');
  assert.throws(()=>resolveRunCfg({config:{application_mode:'tocode',chat_model_config:{credential_id:'tora-official',model:model.id}}},{}),/仅支持/);
  globalThis.fetch=async()=>{throw Error('offline');};assert.equal((await originalFetch(base+'/admin/tochat-quota')).status,502);
  assert.equal((await(await originalFetch(base+'/model/?provider=tora_official')).json()).models[0].name,model.id);
  await configure('');assert.equal((await(await originalFetch(base+'/model/?provider=tora_official')).json()).models.length,0);
 });
}finally{
 // Test callbacks run after registration; cleanup waits for the root test queue.
 test.after(()=>{globalThis.fetch=originalFetch;server.close();rmSync(fixtureDir,{recursive:true,force:true});});
}
