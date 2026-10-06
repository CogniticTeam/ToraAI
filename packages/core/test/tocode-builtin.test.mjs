import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'tora-tocode-official-'));process.env.TORA_HOME=home;
const {loadConfig,saveConfig}=await import('../src/config.js');const {startASAPIServer}=await import('../src/asapi/server.js');const {resolveRunCfg,isRunning,subscribe}=await import('../src/asapi/bridge.js');const {BUILTIN_MODELS}=await import('../src/builtin-models.js');
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
  const cards=await (await get('/model/?provider=tora_official')).json();assert.ok(cards.models.every(card=>card.context_size===BUILTIN_MODELS.find(model=>model.id===card.name).context));assert.deepEqual(cards.models.map(card=>card.name),BUILTIN_MODELS.map(model=>model.id));
  const custom=await (await get('/model/?provider=openai_compatible')).json();assert.deepEqual(custom.models.map(card=>card.name),['personal-model']);
 });
 test('all ToChat and ToCode selections reach the selected model; ToCode retains full tools and permission scope',async()=>{
  const agent=(await (await get('/agent/')).json()).agents[0];const project=join(home,'project');mkdirSync(project);
  for(const model of BUILTIN_MODELS){
   const maximum=resolveRunCfg({config:{application_mode:'tocode',chat_model_config:{credential_id:'tora-official',model:model.id}}});assert.equal(maximum.maxTokensBudget,model.context-24576);
   const reduced=resolveRunCfg({config:{application_mode:'tocode',chat_model_config:{credential_id:'tora-official',model:model.id,parameters:{contextWindow:'300k'}}}});assert.equal(reduced.maxTokensBudget,model.context-24576);
   const mc={type:'tora_official',credential_id:'tora-official',model:model.id,parameters:{thinkingEffort:'max'}};
   const code=resolveRunCfg({config:{application_mode:'tocode',chat_model_config:mc}},agent);assert.equal(code.model,model.id);assert.equal(code.provider,'tochat-official');assert.equal(code.appMode,'tocode');assert.equal(code.tochatMode,'work');assert.equal(code.apiKey,'account-token-only');
   const chat=resolveRunCfg({config:{application_mode:'tochat',model_source:'official',task_mode:'chat',chat_model_config:{...mc,credential_id:'tora-tochat-official'}}},agent);assert.equal(chat.model,model.id);assert.equal(chat.appMode,'tochat');assert.equal(chat.tochatMode,'chat');assert.equal(chat.defaultScopeFullDisk,false);
   outgoing=[];globalThis.fetch=async(url,init)=>{if(String(url)==='https://builtin-fixture.invalid/tochat/title')return Response.json({title:'简短测试标题'});assert.equal(String(url),'https://builtin-fixture.invalid/tochat/v1/chat/completions');outgoing.push({headers:init.headers,body:JSON.parse(init.body)});return new Response('data: '+JSON.stringify({choices:[{delta:{content:'actual '+model.id},finish_reason:'stop'}],usage:{total_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
   const session=await (await post('/sessions/',{agent_id:agent.id,chat_model_config:mc,cwd:project})).json();const run=await post('/chat/',{agent_id:agent.id,session_id:session.session_id,input:{role:'user',content:[{type:'text',text:'Say hello'}]}});assert.equal(run.status,200);
   for(let n=0;n<200&&isRunning(session.session_id);n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(isRunning(session.session_id),false);
   let status;const unsubscribe=subscribe(session.session_id,()=>assert.fail('completed reply must not be replayed'),null,value=>{status=value;});unsubscribe();assert.equal(status.mode,'reset','late initial subscribers must reload the completed reply');
   assert.equal(outgoing.length,1,'title metadata must not create another Agent completion');assert.equal(outgoing[0].body.model,model.id);assert.equal(outgoing[0].body.reasoning_effort,'max');assert.equal(outgoing[0].body.enable_thinking,undefined);assert.equal(outgoing[0].headers['x-tochat-mode'],'work');assert.equal(outgoing[0].headers.authorization,'Bearer account-token-only');assert.ok(outgoing[0].body.tools.some(tool=>tool.function.name==='Bash'));assert.ok(outgoing[0].body.tools.some(tool=>tool.function.name==='Write'));assert.ok(outgoing[0].body.tools.some(tool=>tool.function.name==='Subagent'));
  }
 });
 test('ToChat summarizes first message without blocking reply, protects manual names and deleted sessions',async()=>{
  const agent=(await (await get('/agent/')).json()).agents[0],pending=[];
  globalThis.fetch=async(url,init)=>{
   if(String(url).endsWith('/tochat/title'))return new Promise(resolve=>pending.push({body:JSON.parse(init.body),resolve}));
   return new Response('data: '+JSON.stringify({choices:[{delta:{content:'main reply'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const create=async text=>{
   const made=await (await post('/sessions/',{agent_id:agent.id,application_mode:'tochat',model_source:'official',task_mode:'chat',chat_model_config:{credential_id:'tora-official',model:'gpt-6.1-sol'}})).json();
   await post('/chat/',{agent_id:agent.id,session_id:made.session_id,input:{role:'user',content:[{type:'text',text}]}});
   for(let i=0;i<100&&isRunning(made.session_id);i++)await new Promise(r=>setTimeout(r,10));assert.equal(isRunning(made.session_id),false);
   return made.session_id;
  };
  const read=async id=>(await (await get('/sessions/'+id)).json()).session;
  const manual=await create('请优化手机输入框被键盘遮挡的问题');assert.equal(pending.length,1);assert.equal(pending[0].body.userText,'请优化手机输入框被键盘遮挡的问题');
  assert.equal((await originalFetch(base+'/sessions/'+manual,{method:'PATCH',headers,body:JSON.stringify({name:'手动指定名称'})})).status,200);
  pending[0].resolve(Response.json({title:'自动标题'}));await new Promise(r=>setTimeout(r,20));assert.equal((await read(manual)).config.name,'手动指定名称');
  await post('/chat/',{agent_id:agent.id,session_id:manual,input:{role:'user',content:[{type:'text',text:'第二条不应该重新命名'}]}});for(let i=0;i<100&&isRunning(manual);i++)await new Promise(r=>setTimeout(r,10));assert.equal(pending.length,1);
  const removed=await create('删除期间不要恢复记录');assert.equal(pending.length,2);await originalFetch(base+'/sessions/'+removed,{method:'DELETE',headers});pending[1].resolve(Response.json({title:'不应恢复'}));await new Promise(r=>setTimeout(r,20));assert.equal((await get('/sessions/'+removed)).status,404);
  const automatic=await create('为移动端输入框增加键盘适配');assert.equal(pending.length,3);pending[2].resolve(Response.json({title:'标题：手机键盘适配。'}));await new Promise(r=>setTimeout(r,20));assert.equal((await read(automatic)).config.name,'手机键盘适配');
 });
 test('read-only ToCode permissions reject official-model write proposals',async()=>{
  const {runAgent}=await import('../src/agent.js');const project=join(home,'project'),target=join(project,'must-not-write.txt');let round=0;globalThis.fetch=async()=>new Response('data: '+JSON.stringify({choices:[{delta:round++===0?{tool_calls:[{index:0,id:'write-test',type:'function',function:{name:'Write',arguments:JSON.stringify({path:target,content:'forbidden'})}}]}:{content:'write denied'},finish_reason:round===1?'tool_calls':'stop'}],usage:{total_tokens:10}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  const cfg=resolveRunCfg({config:{application_mode:'tocode',chat_model_config:{credential_id:'tora-official',model:'gpt-6.1-sol'}}},null);
  for await(const event of runAgent({cfg,messages:[{role:'user',content:'Write a file'}],cwd:project,permissionMode:'explore'}))void event;
  assert.equal(existsSync(target),false);assert.equal(round,2);
 });
 test('GPT official transport preserves encrypted reasoning and exact effort with tools',async()=>{
  const {createClient,chatCompletion}=await import('../src/model.js');
  for(const model of BUILTIN_MODELS.filter(item=>item.id.startsWith('gpt-6'))){
   const opaque=[{type:'reasoning',id:'opaque-fixture',encrypted_content:'fixture-encrypted-reasoning',summary:[]}];
   let sent;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'OK'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],tora_response_items:opaque})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
   const client=createClient({...resolveRunCfg({config:{application_mode:'tocode',chat_model_config:{credential_id:'tora-official',model:model.id,parameters:{thinkingEffort:'xhigh'}}}}),supportsTools:true});
   const result=await chatCompletion(client,{messages:[{role:'user',content:'hello'},{role:'assistant',content:'previous',tora_response_items:opaque}],tools:[{type:'function',function:{name:'Read',parameters:{type:'object'}}}]});
   assert.equal(sent.reasoning_effort,'xhigh');assert.equal(sent.enable_thinking,undefined);assert.deepEqual(sent.messages[1].tora_response_items,opaque);assert.deepEqual(result.message.tora_response_items,opaque);
  }
 });
 test('logout clears access without borrowing the configured personal key',async()=>{
  await post('/admin/tochat-config',{baseURL:'https://builtin-fixture.invalid',authToken:''});const result=await (await get('/credential/')).json();assert.ok(!result.credentials.some(credential=>credential.id==='tora-official'));assert.equal((await (await get('/model/?provider=tora_official')).json()).models.length,0);
  const cfg=resolveRunCfg({config:{chat_model_config:{credential_id:'tora-official',model:'gpt-6.1-sol'}}},null);assert.equal(cfg.apiKey,'');assert.notEqual(cfg.apiKey,loadConfig().apiKey);
 });
}finally{
 // node:test cases execute asynchronously; cleanup is registered after them.
 test('fixture cleanup',async()=>{globalThis.fetch=originalFetch;server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));rmSync(home,{recursive:true,force:true});});
}
