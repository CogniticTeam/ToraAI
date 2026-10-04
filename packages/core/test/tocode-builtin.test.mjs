import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'tora-tocode-official-'));process.env.TORA_HOME=home;
const {loadConfig,saveConfig}=await import('../src/config.js');const {startASAPIServer}=await import('../src/asapi/server.js');const {resolveRunCfg,isRunning}=await import('../src/asapi/bridge.js');const {BUILTIN_MODELS}=await import('../src/builtin-models.js');
const originalFetch=globalThis.fetch;const server=await startASAPIServer({port:0});const base='http://127.0.0.1:'+server.address().port;
const headers={'content-type':'application/json','x-user-id':'builtin-fixture'};
const post=(path,body)=>originalFetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
const get=path=>originalFetch(base+path,{headers});
let outgoing=[];
try {
 test('built-in catalog is isolated from custom credentials; login token stays out of API and disk',async()=>{
  saveConfig({apiKey:'personal-key-must-not-be-borrowed',baseURL:'https://personal.invalid/v1',model:'personal-model',modelList:[{id:'custom',model:'personal-model',baseURL:'https://personal.invalid/v1',apiKey:'personal-key-must-not-be-borrowed',provider:'custom',enabled:true}]});
  assert.ok(!(await (await get('/credential/')).json()).credentials.some(credential=>credential.id==='tora-official'));
  const response=await post('/admin/tochat-config',{baseURL:'https://builtin-fixture.invalid',authToken:'account-token-only'});assert.equal(response.status,200);
  assert.equal(loadConfig().tochat.authToken,undefined);
  const credentials=await (await get('/credential/')).json();const official=credentials.credentials.find(credential=>credential.id==='tora-official');assert.equal(official.editable,false);assert.equal(official.data.type,'tora_official');assert.ok(!JSON.stringify(official).includes('account-token-only'));
  const cards=await (await get('/model/?provider=tora_official')).json();assert.deepEqual(cards.models.map(card=>card.name),BUILTIN_MODELS.map(model=>model.id));
  const custom=await (await get('/model/?provider=openai_compatible')).json();assert.deepEqual(custom.models.map(card=>card.name),['personal-model']);
 });
 test('all ToChat and ToCode selections reach the selected model; ToCode retains full tools and permission scope',async()=>{
  const agent=(await (await get('/agent/')).json()).agents[0];const project=join(home,'project');mkdirSync(project);
  for(const model of BUILTIN_MODELS){
   const mc={type:'tora_official',credential_id:'tora-official',model:model.id,parameters:{thinkingEffort:'high'}};
   const code=resolveRunCfg({config:{application_mode:'tocode',chat_model_config:mc}},agent);assert.equal(code.model,model.id);assert.equal(code.provider,'tochat-official');assert.equal(code.appMode,'tocode');assert.equal(code.tochatMode,'work');assert.equal(code.apiKey,'account-token-only');
   const chat=resolveRunCfg({config:{application_mode:'tochat',model_source:'official',task_mode:'chat',chat_model_config:{...mc,credential_id:'tora-tochat-official'}}},agent);assert.equal(chat.model,model.id);assert.equal(chat.appMode,'tochat');assert.equal(chat.tochatMode,'chat');assert.equal(chat.defaultScopeFullDisk,false);
   outgoing=[];globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://builtin-fixture.invalid/tochat/v1/chat/completions');outgoing.push({headers:init.headers,body:JSON.parse(init.body)});return new Response('data: '+JSON.stringify({choices:[{delta:{content:'actual '+model.id},finish_reason:'stop'}],usage:{total_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
   const session=await (await post('/sessions/',{agent_id:agent.id,chat_model_config:mc,cwd:project})).json();const run=await post('/chat/',{agent_id:agent.id,session_id:session.session_id,input:{role:'user',content:[{type:'text',text:'Say hello'}]}});assert.equal(run.status,200);
   for(let n=0;n<200&&isRunning(session.session_id);n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(isRunning(session.session_id),false);
   assert.equal(outgoing.length,1,'automatic naming must not make another paid request');assert.equal(outgoing[0].body.model,model.id);assert.equal(outgoing[0].headers['x-tochat-mode'],'work');assert.equal(outgoing[0].headers.authorization,'Bearer account-token-only');assert.ok(outgoing[0].body.tools.some(tool=>tool.function.name==='Bash'));assert.ok(outgoing[0].body.tools.some(tool=>tool.function.name==='Write'));assert.ok(outgoing[0].body.tools.some(tool=>tool.function.name==='Subagent'));
  }
 });
 test('read-only ToCode permissions reject official-model write proposals',async()=>{
  const {runAgent}=await import('../src/agent.js');const project=join(home,'project'),target=join(project,'must-not-write.txt');let round=0;globalThis.fetch=async()=>new Response('data: '+JSON.stringify({choices:[{delta:round++===0?{tool_calls:[{index:0,id:'write-test',type:'function',function:{name:'Write',arguments:JSON.stringify({path:target,content:'forbidden'})}}]}:{content:'write denied'},finish_reason:round===1?'tool_calls':'stop'}],usage:{total_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  const cfg=resolveRunCfg({config:{application_mode:'tocode',chat_model_config:{credential_id:'tora-official',model:'gpt-6.1-sol'}}},null);
  for await(const event of runAgent({cfg,messages:[{role:'user',content:'Write a file'}],cwd:project,permissionMode:'explore'}))void event;
  assert.equal(existsSync(target),false);assert.equal(round,2);
 });
 test('logout clears access without borrowing the configured personal key',async()=>{
  await post('/admin/tochat-config',{baseURL:'https://builtin-fixture.invalid',authToken:''});const result=await (await get('/credential/')).json();assert.ok(!result.credentials.some(credential=>credential.id==='tora-official'));assert.equal((await (await get('/model/?provider=tora_official')).json()).models.length,0);
  const cfg=resolveRunCfg({config:{chat_model_config:{credential_id:'tora-official',model:'gpt-6.1-sol'}}},null);assert.equal(cfg.apiKey,'');assert.notEqual(cfg.apiKey,loadConfig().apiKey);
 });
}finally{
 // node:test cases execute asynchronously; cleanup is registered after them.
 test('fixture cleanup',async()=>{globalThis.fetch=originalFetch;server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));rmSync(home,{recursive:true,force:true});});
}
