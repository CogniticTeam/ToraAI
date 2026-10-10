import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { quotaPeriods, readToChatQuota, reserveToChat, settleToChat, totalUsage, validateToChatBody, handleToChat } from '../src/tochat.js';
import {usageCost} from '../src/subscription-plans.js';
function database(){const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2);');sqlite.exec(readFileSync(new URL('../migrations/0003_subscriptions.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../migrations/0004_quota_resets.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../migrations/0008_model_access_trials.sql',import.meta.url),'utf8'));sqlite.prepare('INSERT INTO user_subscription VALUES(?,?,?,?,?,?,?)').run(1,'ultrax',Date.now()+2592000000,500000000,1600000000,7000000000,Date.now());const db={prepare(sql){return{bind(...args){return{run(){return{meta:{changes:sqlite.prepare(sql).run(...args).changes}};},first(){return sqlite.prepare(sql).get(...args)||null;},all(){return{results:sqlite.prepare(sql).all(...args)};}};}};},async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};return{db,sqlite};}
const now=Date.parse('2026-10-02T01:00:00Z');
test('Claude 5.5 routes adaptive thinking, protects secrets and charges actual cached/input/output usage; Opus 5 is retired',async()=>{
 const{db,sqlite}=database(),before=globalThis.fetch,tasks=[],sent=[];
 const env={DB:db,SHULIUYUN_CLAUDE_API_KEY:'synthetic-claude-secret'},ctx={waitUntil(p){tasks.push(p);}};
 const ids=['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5'];
 const req=(model,tag,kind='work',effort='high')=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':kind,'x-tora-feature':'tocode','x-tochat-message-id':tag,'x-tochat-request-id':tag+'-request'},body:JSON.stringify({model,reasoning_effort:effort,thinking:{type:'disabled'},output_config:{effort:'none'},max_tokens:256,messages:[{role:'user',content:'Inspect the test file'}],...(kind==='work'?{tools:[{type:'function',function:{name:'Read',parameters:{type:'object'}}}]}:{})})});
 try{
  const catalog=await(await handleToChat(new Request('https://test/tochat/v1/models'),env,ctx,{id:1})).json();assert.deepEqual(catalog.data.map(m=>m.id),ids);assert.ok(!JSON.stringify(catalog).includes(env.SHULIUYUN_CLAUDE_API_KEY));
  const fetchMock=async(url,init)=>{sent.push({url,headers:init.headers,body:JSON.parse(init.body)});return new Response('data: '+JSON.stringify({choices:[{delta:{content:'CLAUDE_OK'},finish_reason:'stop'}],usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:80},completion_tokens:20,input_tokens:1,output_tokens:0,total_tokens:120,completion_tokens_details:{reasoning_tokens:15}}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
  globalThis.fetch=fetchMock;
  assert.equal((await handleToChat(req('claude-opus-5','retired-opus'),env,ctx,{id:1})).status,400);assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM usage_log').get().n,0);
  for(const model of ids){
   assert.equal((await handleToChat(req(model,model+'-missing'),{DB:db,SHULIUYUN_GPT_API_KEY:'unrelated'},ctx,{id:1})).status,503);
   for(const effort of ['low','medium','high','xhigh','max']){
    const tag=model+'-'+effort,response=await handleToChat(req(model,tag,'work',effort),env,ctx,{id:1});assert.equal(response.status,200);assert.match(await response.text(),/CLAUDE_OK/);await Promise.all(tasks);
    const outgoing=sent.at(-1);assert.equal(outgoing.url,'https://shuliuyun.com/v1/chat/completions');assert.equal(outgoing.headers.authorization,'Bearer '+env.SHULIUYUN_CLAUDE_API_KEY);assert.deepEqual(outgoing.body.thinking,{type:'adaptive'});assert.deepEqual(outgoing.body.output_config,{effort});assert.equal(outgoing.body.reasoning_effort,undefined);assert.equal(outgoing.body.tool_choice,'auto');
    const row=sqlite.prepare('SELECT * FROM usage_log WHERE request_id=?').get(tag+'-request');assert.equal(row.cached_tokens,80);assert.equal(row.output_tokens,20);assert.equal(row.credit_micro,usageCost(model,{input:100,cached:80,output:20}));
   }
   const free=await handleToChat(req(model,model+'-free','chat'),env,ctx,{id:1});assert.equal(free.status,200);await free.text();await Promise.all(tasks);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM usage_log WHERE request_id=?').get(model+'-free-request').n,0);
   for(const status of [401,429,500]){globalThis.fetch=async()=>new Response(env.SHULIUYUN_CLAUDE_API_KEY,{status});const failed=await handleToChat(req(model,model+'-error-'+status),env,ctx,{id:1});assert.equal(failed.status,status===429?429:502);assert.ok(!(await failed.text()).includes(env.SHULIUYUN_CLAUDE_API_KEY));}globalThis.fetch=fetchMock;
  }
  assert.ok(sqlite.prepare("SELECT * FROM usage_log WHERE status='failed'").all().every(row=>row.credit_micro===0&&row.held_micro===0));
 }finally{globalThis.fetch=before;sqlite.close();}
});
test('GLM uses only its dedicated secret, retain thinking/tool history and settle actual work usage',async()=>{
 const{db,sqlite}=database(),before=globalThis.fetch,tasks=[],sent=[];
 const env={DB:db,SHULIUYUN_GLM_API_KEY:'synthetic-cn-secret'},ctx={waitUntil(p){tasks.push(p);}};
 const history=[{role:'user',content:'Read the test file'},{role:'assistant',content:null,reasoning_content:'I should inspect it.',tool_calls:[{id:'read-fixture',type:'function',function:{name:'Read',arguments:'{"path":"test.txt"}'}}]},{role:'tool',tool_call_id:'read-fixture',content:'test data'}];
 const req=(model,tag,kind='work',effort='high')=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':kind,'x-tora-feature':'tocode','x-tochat-message-id':tag,'x-tochat-request-id':tag+'-request'},body:JSON.stringify({model,messages:history,reasoning_effort:effort,max_tokens:256,...(kind==='work'?{tools:[{type:'function',function:{name:'Read',parameters:{type:'object'}}}]}:{})})});
 try{
  const list=await(await handleToChat(new Request('https://test/tochat/v1/models'),env,ctx,{id:1})).json();assert.deepEqual(list.data.map(m=>m.id),['glm-5.3']);assert.deepEqual(list.data[0].input_modalities,['text']);assert.ok(!JSON.stringify(list).includes(env.SHULIUYUN_GLM_API_KEY));
  globalThis.fetch=async(url,init)=>{sent.push({url,headers:init.headers,body:JSON.parse(init.body)});return new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'Verified.',content:'CN_OK'},finish_reason:'stop'}],usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:80},completion_tokens:20,completion_tokens_details:{reasoning_tokens:18},total_tokens:120}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
  for(const model of ['glm-5.3']){
   const slug=model.replaceAll('.','-');
   assert.equal((await handleToChat(req(model,slug+'-missing'),{DB:db,SHULIUYUN_API_KEY:'unrelated'},ctx,{id:1})).status,503);
   for(const effort of ['low','high','max']){
    const tag=slug+'-'+effort,response=await handleToChat(req(model,tag,'work',effort),env,ctx,{id:1});assert.equal(response.status,200);assert.match(await response.text(),/CN_OK/);await Promise.all(tasks);
    const outgoing=sent.at(-1);assert.equal(outgoing.url,'https://shuliuyun.com/v1/chat/completions');assert.equal(outgoing.headers.authorization,'Bearer '+env.SHULIUYUN_GLM_API_KEY);assert.equal(outgoing.body.reasoning_effort,effort);assert.equal(outgoing.body.thinking?.type,'enabled');assert.deepEqual(outgoing.body.messages,history);assert.equal(outgoing.body.tools[0].function.name,'Read');
    const row=sqlite.prepare('SELECT * FROM usage_log WHERE request_id=?').get(tag+'-request');assert.equal(row.cached_tokens,80);assert.equal(row.output_tokens,20);assert.equal(row.feature,'tocode');assert.equal(row.credit_micro,usageCost(model,{input:100,cached:80,output:20}));
   }
   const response=await handleToChat(req(model,slug+'-free','chat'),env,ctx,{id:1});assert.equal(response.status,200);await response.text();await Promise.all(tasks);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM usage_log WHERE request_id=?').get(slug+'-free-request').n,0);
   for(const effort of ['medium','xhigh','off'])assert.throws(()=>validateToChatBody({model,messages:history,reasoning_effort:effort},'work'),/不支持/);
   for(const status of [401,403,429,500]){globalThis.fetch=async()=>new Response(env.SHULIUYUN_GLM_API_KEY,{status});const failed=await handleToChat(req(model,slug+'-error-'+status),env,ctx,{id:1});assert.equal(failed.status,status===429?429:502);assert.ok(!(await failed.text()).includes(env.SHULIUYUN_GLM_API_KEY));}
   globalThis.fetch=async(url,init)=>{sent.push({url,headers:init.headers,body:JSON.parse(init.body)});return new Response('data: '+JSON.stringify({choices:[{delta:{content:'CN_OK'},finish_reason:'stop'}],usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:80},completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
  }
  const image=[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}];assert.throws(()=>validateToChatBody({model:'glm-5.3',messages:image},'chat'),/不支持图片/);
  assert.ok(sqlite.prepare("SELECT * FROM usage_log WHERE status='failed'").all().every(row=>row.credit_micro===0&&row.held_micro===0));
 }finally{globalThis.fetch=before;sqlite.close();}
});
test('聊天禁止执行工具；工作SSE保留图片与max；未登录拒绝；Secret不会回传',async()=>{
 const body={model:'deepseek-flash',messages:[{role:'user',content:[{type:'text',text:'hello'},{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}],reasoning_effort:'max'};
 assert.throws(()=>validateToChatBody({...body,tools:[{function:{name:'Bash'}}]},'chat'),/只允许/);
 const{db,sqlite}=database();const env={DB:db,DEEPSEEK_API_KEY:'server-only-test-key'};let outgoing;const fetchBefore=globalThis.fetch;
 const tasks=[];const ctx={waitUntil(promise){tasks.push(promise);}};
 try{globalThis.fetch=async(url,init)=>{outgoing={url,body:JSON.parse(init.body),headers:init.headers};return new Response('data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:80,completion_tokens:20,total_tokens:100}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
 const request=()=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':'work','x-tochat-message-id':'message-real','x-tochat-request-id':'request-real'},body:JSON.stringify(body)});
 assert.equal((await handleToChat(request(),env,ctx,null)).status,401);
 const response=await handleToChat(request(),env,ctx,{id:1,banned:0});assert.equal(response.status,200);const content=await response.text();await Promise.all(tasks);assert.ok(!content.includes(env.DEEPSEEK_API_KEY));assert.equal(outgoing.body.reasoning_effort,'max');assert.equal(outgoing.body.messages[0].content[1].type,'image_url');assert.ok((await readToChatQuota(db,1)).remainingPercent<100);
 assert.equal((await handleToChat(request(),env,ctx,{id:1})).status,409);
 }finally{globalThis.fetch=fetchBefore;sqlite.close();}
});
test('内置 Gemini 独立 Secret、白名单、无隐式回退、流式工具与共享额度',async()=>{
 const {db,sqlite}=database(),before=globalThis.fetch,tasks=[];const ctx={waitUntil(task){tasks.push(task);}};
 const env={DB:db,DEEPSEEK_API_KEY:'deepseek-test-only',SHULIUYUN_API_KEY:'gemini-test-only'};
 const request=(model,tag='gemini-first')=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':'chat','x-tochat-message-id':tag,'x-tochat-request-id':tag+'-request'},body:JSON.stringify({model,messages:[{role:'user',content:'hello'}],reasoning_effort:'max',tools:[{type:'function',function:{name:'WebSearch',parameters:{type:'object'}}}]})});
 try {
  const quota=await (await handleToChat(new Request('https://test/tochat/quota'),env,ctx,{id:1})).json();
  assert.deepEqual(quota.models.filter(item=>item.enabled).map(item=>item.id),['deepseek-flash','gemini-3.8-flash']);assert.equal(quota.models.length,12);assert.ok(!JSON.stringify(quota).includes('test-only'));
  let calls=0;
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://shuliuyun.com/v1/chat/completions');assert.equal(init.headers.authorization,'Bearer gemini-test-only');const body=JSON.parse(init.body);assert.equal(body.model,'gemini-3.8-flash');assert.equal(body.thinking,undefined);assert.equal(body.reasoning_effort,'high');assert.equal(body.tool_choice,'auto');assert.equal(body.stream_options.include_usage,true);return new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{id:'search-call',index:0,type:'function',function:{name:'WebSearch',arguments:'{"query":"Tora"}'}}]},finish_reason:'tool_calls'}],usage:{total_tokens:300}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
  const response=await handleToChat(request('gemini-3.8-flash'),env,ctx,{id:1});assert.equal(response.status,200);assert.match(await response.text(),/WebSearch/);await Promise.all(tasks);assert.equal((await readToChatQuota(db,1)).chatUnlimited,true);
  assert.equal((await handleToChat(request('other-model','unknown-model'),env,ctx,{id:1})).status,400);
  assert.equal((await handleToChat(request('toString','prototype-model'),env,ctx,{id:1})).status,400);
  assert.equal((await handleToChat(request('gemini-3.8-flash','secret-missing'),{DB:db,DEEPSEEK_API_KEY:env.DEEPSEEK_API_KEY},ctx,{id:1})).status,503);assert.equal(calls,1);
  const catalog=await (await handleToChat(new Request('https://test/tochat/v1/models'),{DB:db,SHULIUYUN_API_KEY:env.SHULIUYUN_API_KEY},ctx,{id:1})).json();assert.deepEqual(catalog.data.map(item=>item.id),['gemini-3.8-flash']);
  for(const status of [401,429,500]){globalThis.fetch=async()=>{calls++;return new Response('upstream secret must not be reflected',{status});};const failed=await handleToChat(request('gemini-3.8-flash','status-'+status),env,ctx,{id:1});assert.equal(failed.status,status===429?429:502);assert.ok(!(await failed.text()).includes('upstream secret'));}
  assert.equal(calls,4);assert.equal((await readToChatQuota(db,1)).chatUnlimited,true);
 }finally{globalThis.fetch=before;sqlite.close();}
});

test('Gemini low/medium/high 原值转发；DeepSeek 不接受 medium',async()=>{
 const {db,sqlite}=database(),before=globalThis.fetch,tasks=[],sent=[];
 const env={DB:db,SHULIUYUN_API_KEY:'synthetic-medium-secret'};const ctx={waitUntil(task){tasks.push(task);}};
 const body={model:'gemini-3.8-flash',messages:[{role:'user',content:'hello'}]};
 try{globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return new Response('data: '+JSON.stringify({choices:[{delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
  for(const effort of ['low','medium','high']){const response=await handleToChat(new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':'chat','x-tochat-message-id':'effort-'+effort,'x-tochat-request-id':'effort-'+effort+'-request'},body:JSON.stringify({...body,reasoning_effort:effort})}),env,ctx,{id:1});assert.equal(response.status,200);await response.text();await Promise.all(tasks);}
  assert.deepEqual(sent.map(body=>body.reasoning_effort),['low','medium','high']);assert.ok(sent.every(body=>body.thinking===undefined));
  assert.throws(()=>validateToChatBody({...body,model:'deepseek-flash',reasoning_effort:'medium'},'chat'),/不支持/);
 }finally{globalThis.fetch=before;sqlite.close();}
});

test('GPT Sol uses only dedicated Codex Secret and Responses; missing secret never falls back',async()=>{
 const {db,sqlite}=database(),before=globalThis.fetch,tasks=[],sent=[];const ctx={waitUntil(task){tasks.push(task);}};
 const request=effort=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':'work','x-tochat-message-id':'sol-message-'+effort,'x-tochat-request-id':'sol-request-'+effort},body:JSON.stringify({model:'gpt-6.1-sol',messages:[{role:'user',content:'hello'}],reasoning_effort:effort,tools:[{type:'function',function:{name:'Read',parameters:{type:'object'}}}]})});
 try{globalThis.fetch=async(url,init)=>{sent.push({url,body:JSON.parse(init.body)});assert.equal(init.headers.authorization,'Bearer dedicated-codex-key');return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'OK'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:10,output_tokens:20,total_tokens:30}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
 assert.equal((await handleToChat(request('low'),{DB:db,SHULIUYUN_API_KEY:'default-group-key'},ctx,{id:1})).status,503);assert.equal(sent.length,0);
 for(const effort of ['low','medium','high','xhigh','max']){const response=await handleToChat(request(effort),{DB:db,SHULIUYUN_GPT_API_KEY:'dedicated-codex-key'},ctx,{id:1});assert.equal(response.status,200);assert.match(await response.text(),/OK/);await Promise.all(tasks);}
 assert.ok(sent.every(item=>item.url==='https://shuliuyun.com/v1/responses'));assert.deepEqual(sent.map(item=>item.body.reasoning.effort),['low','medium','high','xhigh','max']);assert.ok(sent.every(item=>item.body.tools[0].name==='Read'&&item.body.thinking===undefined));assert.ok((await readToChatQuota(db,1)).remainingPercent<100);
 }finally{globalThis.fetch=before;sqlite.close();}
});

test('official work permits review after a completed reply, charges actual tokens and keeps chat closed',async()=>{
 const {db,sqlite}=database();
 await reserveToChat(db,{userId:31,messageId:'code-review-turn',requestId:'code-answer',kind:'work',fingerprint:'work',reserved:100,now});await settleToChat(db,{userId:31,messageId:'code-review-turn',requestId:'code-answer',usage:{total_tokens:50}});
 await reserveToChat(db,{userId:31,messageId:'code-review-turn',requestId:'code-review',kind:'work',fingerprint:'work',reserved:100,now});await settleToChat(db,{userId:31,messageId:'code-review-turn',requestId:'code-review',usage:{total_tokens:30}});assert.equal(sqlite.prepare('SELECT SUM(charged) AS n FROM tochat_requests WHERE user_id=31').get().n,80);
 await reserveToChat(db,{userId:32,messageId:'chat-answer',requestId:'chat-first',kind:'chat',fingerprint:'chat',reserved:1,now});await settleToChat(db,{userId:32,messageId:'chat-answer',requestId:'chat-first',usage:{total_tokens:10}});
 await assert.rejects(reserveToChat(db,{userId:32,messageId:'chat-answer',requestId:'chat-repeat',kind:'chat',fingerprint:'chat',reserved:1,now}),/BUSY_OR_DONE/);sqlite.close();
});

test('new GPT family and Claude use dedicated secrets and charge cached/input/output tokens', async()=>{
 const {db,sqlite}=database(),before=globalThis.fetch,tasks=[];const ctx={waitUntil(task){tasks.push(task);}};
 try {
  for(const model of ['gpt-6-sol','gpt-6-luna','gpt-6-astra','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5']){
   const gpt=model.startsWith('gpt'),secret=gpt?'SHULIUYUN_GPT_API_KEY':'SHULIUYUN_CLAUDE_API_KEY';
   const request=()=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':'work','x-tora-feature':'tocode','x-tochat-message-id':model,'x-tochat-request-id':model+'-request'},body:JSON.stringify({model,reasoning_effort:'medium',max_tokens:256,messages:[{role:'user',content:'hello'}],tools:[{type:'function',function:{name:'Read',parameters:{type:'object'}}}]})});
   assert.equal((await handleToChat(request(),{DB:db,SHULIUYUN_API_KEY:'unrelated-gemini-key'},ctx,{id:1})).status,503);
   globalThis.fetch=async(url,init)=>{
    const body=JSON.parse(init.body);assert.equal(init.headers.authorization,'Bearer dedicated-fixture-key');assert.equal(body.model,model);
    assert.equal(url,'https://shuliuyun.com/v1/'+(gpt?'responses':'chat/completions'));
    assert.equal(gpt?body.reasoning.effort:body.output_config.effort,'medium');assert.equal(gpt?body.tools[0].name:body.tools[0].function.name,'Read');
    const event=gpt?{type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:100,output_tokens:10,total_tokens:110,input_tokens_details:{cached_tokens:80}}}}:{choices:[{delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,prompt_tokens_details:{cached_tokens:80}}};
    return new Response('data: '+JSON.stringify(event)+'\n\n'+(gpt?'':'data: [DONE]\n\n'),{headers:{'content-type':'text/event-stream'}});
   };
   const response=await handleToChat(request(),{DB:db,[secret]:'dedicated-fixture-key'},ctx,{id:1});assert.equal(response.status,200);assert.match(await response.text(),/OK/);await Promise.all(tasks);
   const row=sqlite.prepare('SELECT * FROM usage_log WHERE request_id=?').get(model+'-request');assert.equal(row.model,model);assert.equal(row.cached_tokens,80);assert.equal(row.output_tokens,10);assert.ok(row.credit_micro>0);
  }
 }finally{globalThis.fetch=before;sqlite.close();}
});

test('Doubao is free without subscription, forwards multimodal Responses, and rejects Work/ToCode before upstream or quota writes',async()=>{
 const {db,sqlite}=database(),before=globalThis.fetch,tasks=[],sent=[];
 sqlite.exec('DELETE FROM user_subscription');
 const env={DB:db,ARK_API_KEY:'synthetic-ark-secret'},ctx={waitUntil(p){tasks.push(p);}};
 const body={model:'doubao-seed-2-1-lite-260915',reasoning_effort:'medium',messages:[{role:'user',content:[{type:'text',text:'Describe attachments'},{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}},{type:'input_audio',audio_url:'data:audio/wav;base64,aGVsbG8='},{type:'input_video',video_url:'data:video/mp4;base64,aGVsbG8=',fps:1000}]}]};
 const req=(mode='chat',feature)=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':mode,'x-tochat-message-id':'doubao-message','x-tochat-request-id':'doubao-request',...(feature?{'x-tora-feature':feature}:{})},body:JSON.stringify(body)});
 try{
  globalThis.fetch=async(url,init)=>{sent.push({url,body:JSON.parse(init.body),headers:init.headers});return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'Attachments understood'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:200,output_tokens:20,total_tokens:220}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
  assert.equal((await handleToChat(req('work'),env,ctx,{id:1})).status,400);
  assert.equal((await handleToChat(req('chat','tocode'),env,ctx,{id:1})).status,403);
  assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM tochat_requests').get().n,0);
  const response=await handleToChat(req(),env,ctx,{id:1});assert.equal(response.status,200);assert.match(await response.text(),/Attachments understood/);await Promise.all(tasks);
  assert.equal(sent[0].url,'https://ark.cn-beijing.volces.com/api/v3/responses');assert.equal(sent[0].headers.authorization,'Bearer synthetic-ark-secret');assert.equal(sent[0].body.reasoning.effort,'medium');assert.equal(sent[0].body.reasoning.summary,undefined);
  assert.deepEqual(sent[0].body.input[0].content.map(p=>p.type),['input_text','input_image','input_audio','input_video']);assert.equal(sent[0].body.input[0].content[3].fps,1);assert.equal(sent[0].body.store,false);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM usage_log').get().n,0);assert.equal(sqlite.prepare('SELECT charged FROM tochat_requests').get().charged,0);
  const list=await (await handleToChat(new Request('https://test/tochat/v1/models'),env,ctx,{id:1})).json();assert.equal(list.data[0].free,true);assert.deepEqual(list.data[0].modes,['chat']);assert.deepEqual(list.data[0].input_modalities,['text','image','audio','video']);assert.ok(!JSON.stringify(list).includes(env.ARK_API_KEY));
  const work=await (await handleToChat(new Request('https://test/tochat/v1/models',{headers:{'x-tochat-mode':'work'}}),env,ctx,{id:1})).json();assert.deepEqual(work.data,[]);
  assert.throws(()=>validateToChatBody({...body,model:'deepseek-flash',reasoning_effort:'high'},'chat'),/音频和视频/);
  assert.throws(()=>validateToChatBody({...body,messages:[{role:'user',content:[{type:'input_audio',audio_url:'https://private.invalid/audio.wav'}]}]},'chat'),/上传/);
  assert.throws(()=>validateToChatBody({...body,messages:[{role:'assistant',content:[{type:'input_video',video_url:'data:video/mp4;base64,aGVsbG8='}]}]},'chat'),/用户附件/);
 }finally{globalThis.fetch=before;sqlite.close();}
});

test('Grok uses its dedicated secret, four efforts, Responses and server-selected cache affinity for work/ToCode',async()=>{
 const{db,sqlite}=database();const before=globalThis.fetch,tasks=[],outgoing=[];
 const env={DB:db,SHULIUYUN_GROK_API_KEY:'synthetic-grok-key'};const ctx={waitUntil(task){tasks.push(task);}};
 const body={model:'grok-4.7',messages:[{role:'user',content:'Reply OK'}],reasoning_effort:'high',prompt_cache_key:'client-injected-cache-key'};
 const request=(suffix,kind='work',effort='high')=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':kind,'x-tora-feature':'tocode','x-tochat-message-id':'grok-message-'+suffix,'x-tochat-request-id':'grok-request-'+suffix},body:JSON.stringify({...body,reasoning_effort:effort})});
 try{
  for(const effort of ['low','medium','high','xhigh'])assert.equal(validateToChatBody({...body,reasoning_effort:effort},'work').effort,effort);
  for(const effort of ['max','off'])assert.throws(()=>validateToChatBody({...body,reasoning_effort:effort},'chat'),/不支持/);
  assert.equal((await handleToChat(request('missing'),{DB:db,SHULIUYUN_API_KEY:'unrelated-key'},ctx,{id:1})).status,503);
  const catalog=await (await handleToChat(new Request('https://test/tochat/v1/models',{headers:{'x-tora-feature':'tocode'}}),env,ctx,{id:1})).json();
  assert.deepEqual(catalog.data.map(model=>model.id),['grok-4.7']);assert.ok(!JSON.stringify(catalog).includes(env.SHULIUYUN_GROK_API_KEY));
  globalThis.fetch=async(url,init)=>{outgoing.push({url,headers:init.headers,body:JSON.parse(init.body)});return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'GROK_OK'}]}],usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:80},output_tokens_details:{reasoning_tokens:18}}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
  for(const [index,effort] of ['low','medium','high','xhigh'].entries()){const response=await handleToChat(request(String(index),index===0?'chat':'work',effort),env,ctx,{id:1});assert.equal(response.status,200);const raw=await response.text();assert.match(raw,/GROK_OK/);assert.ok(!raw.includes(env.SHULIUYUN_GROK_API_KEY));await Promise.all(tasks);}
  assert.ok(outgoing.every(r=>r.url==='https://shuliuyun.com/v1/responses'&&r.headers.authorization==='Bearer '+env.SHULIUYUN_GROK_API_KEY));
  assert.ok(outgoing.every(r=>!('summary' in r.body.reasoning)&&/^[a-f0-9]{64}$/.test(r.body.prompt_cache_key)));
  assert.equal(new Set(outgoing.map(r=>r.body.prompt_cache_key)).size,1);
  const rows=(await db.prepare('SELECT * FROM usage_log').bind().all()).results;assert.equal(rows.length,3);
  assert.ok(rows.every(row=>row.model==='grok-4.7'&&row.feature==='tocode'&&row.credit_micro===20*166+80*42+20*497));
  for(const status of [401,429,500]){globalThis.fetch=async()=>new Response(env.SHULIUYUN_GROK_API_KEY,{status});const response=await handleToChat(request('error-'+status),env,ctx,{id:1});assert.equal(response.status,status===429?429:502);assert.ok(!(await response.text()).includes(env.SHULIUYUN_GROK_API_KEY));}
  assert.ok((await db.prepare("SELECT * FROM usage_log WHERE status='failed'").bind().all()).results.every(row=>row.credit_micro===0&&row.held_micro===0));
 }finally{globalThis.fetch=before;sqlite.close();}
});
