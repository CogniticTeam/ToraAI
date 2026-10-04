import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { quotaPeriods, readToChatQuota, reserveToChat, settleToChat, totalUsage, validateToChatBody, handleToChat } from '../src/tochat.js';
function database(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../migrations/0002_tochat.sql',import.meta.url),'utf8'));const db={prepare(sql){return{bind(...args){return{run(){return{meta:{changes:sqlite.prepare(sql).run(...args).changes}};},first(){return sqlite.prepare(sql).get(...args)||null;},all(){return{results:sqlite.prepare(sql).all(...args)};}};}};},async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};return{db,sqlite};}
const now=Date.parse('2026-10-02T01:00:00Z');
test('北京时间日与周边界；思考用量不重复计数',()=>{
 assert.equal(quotaPeriods(Date.parse('2026-10-04T15:59:59Z')).week,'2026-09-28');
 assert.equal(quotaPeriods(Date.parse('2026-10-04T16:00:00Z')).week,'2026-10-05');
 assert.equal(quotaPeriods(now).dailyReset,'2026-10-02T16:00:00.000Z');
 assert.equal(totalUsage({prompt_tokens:100,completion_tokens:200,completion_tokens_details:{reasoning_tokens:150}}),300);
});
test('150条聊天硬上限、失败释放、同账号并发、跨日重置',async()=>{
 const{db,sqlite}=database();
 for(let i=0;i<150;i++){const messageId='message-'+i,requestId='request-'+i;await reserveToChat(db,{userId:1,messageId,requestId,kind:'chat',fingerprint:'x',reserved:100,now});await settleToChat(db,{userId:1,messageId,requestId,usage:{total_tokens:50}});}
 await assert.rejects(reserveToChat(db,{userId:1,messageId:'over-limit',requestId:'request-over',kind:'chat',fingerprint:'x',reserved:100,now}),/CHAT_LIMIT/);
 assert.equal((await readToChatQuota(db,1,now)).chatRemaining,0);
 assert.equal((await readToChatQuota(db,1,now+86400000)).chatRemaining,150);
 await reserveToChat(db,{userId:2,messageId:'failed-msg',requestId:'failed-req',kind:'chat',fingerprint:'x',reserved:100,now});await settleToChat(db,{userId:2,messageId:'failed-msg',requestId:'failed-req',failed:true});assert.equal((await readToChatQuota(db,2,now)).chatRemaining,150);
 sqlite.close();
});
test('工作日/周额度原子检查、结算幂等、未知usage不退款、聊天工具继续不重复计条',async()=>{
 const{db,sqlite}=database();
 await reserveToChat(db,{userId:1,messageId:'work-msg',requestId:'work-req',kind:'work',fingerprint:'x',reserved:999900,now});
 await assert.rejects(reserveToChat(db,{userId:1,messageId:'work-2',requestId:'work-req2',kind:'work',fingerprint:'x',reserved:200,now}),/DAY_LIMIT/);
 await settleToChat(db,{userId:1,messageId:'work-msg',requestId:'work-req',usage:{total_tokens:1000}});await settleToChat(db,{userId:1,messageId:'work-msg',requestId:'work-req',usage:{total_tokens:2000}});
 assert.equal((await readToChatQuota(db,1,now)).workDailyUsed,1000);
 sqlite.exec('DROP TRIGGER tochat_request_quota');
 sqlite.prepare("INSERT INTO tochat_requests VALUES(?,?,?,?,?,?,?,'settled',?,?)").run(3,'past','past-msg','2026-10-01',quotaPeriods(now).week,'work',9999900,now,now);
 sqlite.exec(readFileSync(new URL('../migrations/0002_tochat.sql',import.meta.url),'utf8'));
 await assert.rejects(reserveToChat(db,{userId:3,messageId:'week-msg',requestId:'week-req',kind:'work',fingerprint:'x',reserved:200,now}),/WEEK_LIMIT/);
 await reserveToChat(db,{userId:2,messageId:'unknown',requestId:'unknown-req',kind:'work',fingerprint:'x',reserved:2000,now});await settleToChat(db,{userId:2,messageId:'unknown',requestId:'unknown-req',unknown:true});assert.equal((await readToChatQuota(db,2,now)).workDailyUsed,2000);
 await reserveToChat(db,{userId:4,messageId:'chat-turn',requestId:'round-one',kind:'chat',fingerprint:'x',reserved:1,now});await settleToChat(db,{userId:4,messageId:'chat-turn',requestId:'round-one',usage:{total_tokens:1},tools:['search-id']});await reserveToChat(db,{userId:4,messageId:'chat-turn',requestId:'round-two',kind:'chat',fingerprint:'x',reserved:1,now});assert.equal((await readToChatQuota(db,4,now)).chatUsed,1);
 sqlite.close();
});
test('聊天禁止执行工具；工作SSE保留图片与max；未登录拒绝；Secret不会回传',async()=>{
 const body={model:'deepseek-flash',messages:[{role:'user',content:[{type:'text',text:'hello'},{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}],reasoning_effort:'max'};
 assert.throws(()=>validateToChatBody({...body,tools:[{function:{name:'Bash'}}]},'chat'),/只允许/);
 const{db,sqlite}=database();const env={DB:db,DEEPSEEK_API_KEY:'server-only-test-key'};let outgoing;const fetchBefore=globalThis.fetch;
 const tasks=[];const ctx={waitUntil(promise){tasks.push(promise);}};
 try{globalThis.fetch=async(url,init)=>{outgoing={url,body:JSON.parse(init.body),headers:init.headers};return new Response('data: '+JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{total_tokens:100}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
 const request=()=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':'work','x-tochat-message-id':'message-real','x-tochat-request-id':'request-real'},body:JSON.stringify(body)});
 assert.equal((await handleToChat(request(),env,ctx,null)).status,401);
 const response=await handleToChat(request(),env,ctx,{id:1,banned:0});assert.equal(response.status,200);const content=await response.text();await Promise.all(tasks);assert.ok(!content.includes(env.DEEPSEEK_API_KEY));assert.equal(outgoing.body.reasoning_effort,'max');assert.equal(outgoing.body.messages[0].content[1].type,'image_url');assert.equal((await readToChatQuota(db,1)).workDailyUsed,100);
 assert.equal((await handleToChat(request(),env,ctx,{id:1})).status,409);
 }finally{globalThis.fetch=fetchBefore;sqlite.close();}
});
test('内置 Gemini 独立 Secret、白名单、无隐式回退、流式工具与共享额度',async()=>{
 const {db,sqlite}=database(),before=globalThis.fetch,tasks=[];const ctx={waitUntil(task){tasks.push(task);}};
 const env={DB:db,DEEPSEEK_API_KEY:'deepseek-test-only',SHULIUYUN_API_KEY:'gemini-test-only'};
 const request=(model,tag='gemini-first')=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':'chat','x-tochat-message-id':tag,'x-tochat-request-id':tag+'-request'},body:JSON.stringify({model,messages:[{role:'user',content:'hello'}],reasoning_effort:'max',tools:[{type:'function',function:{name:'WebSearch',parameters:{type:'object'}}}]})});
 try {
  const quota=await (await handleToChat(new Request('https://test/tochat/quota'),env,ctx,{id:1})).json();
  assert.deepEqual(quota.models.map(item=>[item.id,item.enabled]),[['deepseek-flash',true],['gemini-3.8-flash',true],['gpt-6.1-sol',false]]);assert.ok(!JSON.stringify(quota).includes('test-only'));
  let calls=0;
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://shuliuyun.com/v1/chat/completions');assert.equal(init.headers.authorization,'Bearer gemini-test-only');const body=JSON.parse(init.body);assert.equal(body.model,'gemini-3.8-flash');assert.equal(body.thinking,undefined);assert.equal(body.reasoning_effort,'high');assert.equal(body.tool_choice,'auto');assert.equal(body.stream_options.include_usage,true);return new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{id:'search-call',index:0,type:'function',function:{name:'WebSearch',arguments:'{"query":"Tora"}'}}]},finish_reason:'tool_calls'}],usage:{total_tokens:300}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
  const response=await handleToChat(request('gemini-3.8-flash'),env,ctx,{id:1});assert.equal(response.status,200);assert.match(await response.text(),/WebSearch/);await Promise.all(tasks);assert.equal((await readToChatQuota(db,1)).chatUsed,1);
  assert.equal((await handleToChat(request('other-model','unknown-model'),env,ctx,{id:1})).status,400);
  assert.equal((await handleToChat(request('toString','prototype-model'),env,ctx,{id:1})).status,400);
  assert.equal((await handleToChat(request('gemini-3.8-flash','secret-missing'),{DB:db,DEEPSEEK_API_KEY:env.DEEPSEEK_API_KEY},ctx,{id:1})).status,503);assert.equal(calls,1);
  const catalog=await (await handleToChat(new Request('https://test/tochat/v1/models'),{DB:db,SHULIUYUN_API_KEY:env.SHULIUYUN_API_KEY},ctx,{id:1})).json();assert.deepEqual(catalog.data.map(item=>item.id),['gemini-3.8-flash']);
  for(const status of [401,429,500]){globalThis.fetch=async()=>{calls++;return new Response('upstream secret must not be reflected',{status});};const failed=await handleToChat(request('gemini-3.8-flash','status-'+status),env,ctx,{id:1});assert.equal(failed.status,status===429?429:502);assert.ok(!(await failed.text()).includes('upstream secret'));}
  assert.equal(calls,4);assert.equal((await readToChatQuota(db,1)).chatUsed,1);
 }finally{globalThis.fetch=before;sqlite.close();}
});

test('Gemini low/medium/high 原值转发；DeepSeek 不接受 medium',async()=>{
 const {db,sqlite}=database(),before=globalThis.fetch,tasks=[],sent=[];
 const env={DB:db,SHULIUYUN_API_KEY:'synthetic-medium-secret'};const ctx={waitUntil(task){tasks.push(task);}};
 const body={model:'gemini-3.8-flash',messages:[{role:'user',content:'hello'}]};
 try{globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return new Response('data: '+JSON.stringify({choices:[{delta:{content:'OK'},finish_reason:'stop'}],usage:{total_tokens:20}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
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
 assert.ok(sent.every(item=>item.url==='https://shuliuyun.com/v1/responses'));assert.deepEqual(sent.map(item=>item.body.reasoning.effort),['low','medium','high','xhigh','max']);assert.ok(sent.every(item=>item.body.tools[0].name==='Read'&&item.body.thinking===undefined));assert.equal((await readToChatQuota(db,1)).workDailyUsed,150);
 }finally{globalThis.fetch=before;sqlite.close();}
});

test('official work permits review after a completed reply, charges actual tokens and keeps chat closed',async()=>{
 const {db,sqlite}=database();
 await reserveToChat(db,{userId:31,messageId:'code-review-turn',requestId:'code-answer',kind:'work',fingerprint:'work',reserved:100,now});await settleToChat(db,{userId:31,messageId:'code-review-turn',requestId:'code-answer',usage:{total_tokens:50}});
 await reserveToChat(db,{userId:31,messageId:'code-review-turn',requestId:'code-review',kind:'work',fingerprint:'work',reserved:100,now});await settleToChat(db,{userId:31,messageId:'code-review-turn',requestId:'code-review',usage:{total_tokens:30}});assert.equal((await readToChatQuota(db,31,now)).workDailyUsed,80);
 await reserveToChat(db,{userId:32,messageId:'chat-answer',requestId:'chat-first',kind:'chat',fingerprint:'chat',reserved:1,now});await settleToChat(db,{userId:32,messageId:'chat-answer',requestId:'chat-first',usage:{total_tokens:10}});
 await assert.rejects(reserveToChat(db,{userId:32,messageId:'chat-answer',requestId:'chat-repeat',kind:'chat',fingerprint:'chat',reserved:1,now}),/BUSY_OR_DONE/);sqlite.close();
});
