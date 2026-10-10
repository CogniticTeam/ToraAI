import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleToChat,readToChatQuota,reserveToChat,settleToChat} from '../src/tochat.js';
import {PLANS,CREDIT_SCALE} from '../src/subscription-plans.js';
import {MODEL_MINIMUM_PLAN,hasModelSubscription} from '../../core/src/model-access.js';
function fixture(beforeMigration=''){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2),(3);');
 for(const file of ['0003_subscriptions.sql','0004_quota_resets.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 if(beforeMigration)sqlite.exec(beforeMigration);
 const migrate=()=>sqlite.exec(readFileSync(new URL('../migrations/0008_model_access_trials.sql',import.meta.url),'utf8'));migrate();
 let queue=Promise.resolve();
 const DB={prepare(sql){const stmt=args=>({bind:(...values)=>stmt(values),first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>({meta:sqlite.prepare(sql).run(...args)})});return stmt([]);},batch(items){const run=async()=>{sqlite.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}};const result=queue.then(run);queue=result.catch(()=>{});return result;}};
 const env={DB,DEEPSEEK_API_KEY:'test-only',ARK_API_KEY:'test-only',SHULIUYUN_GPT_API_KEY:'test-only',SHULIUYUN_GROK_API_KEY:'test-only',SHULIUYUN_CLAUDE_API_KEY:'test-only',SHULIUYUN_GLM_API_KEY:'test-only',SHULIUYUN_API_KEY:'test-only'};
 const tasks=[],ctx={waitUntil:p=>tasks.push(p)};
 const grant=(planId,id=1,expiry=Date.now()+86400000)=>{const plan=PLANS.find(p=>p.id===planId);sqlite.prepare('INSERT INTO user_subscription VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan_id=excluded.plan_id,expires_at=excluded.expires_at,five_hour_limit=excluded.five_hour_limit,week_limit=excluded.week_limit,month_limit=excluded.month_limit').run(id,plan.id,expiry,(plan.limits.fiveHour||0)*CREDIT_SCALE,(plan.limits.week||0)*CREDIT_SCALE,(plan.limits.month||0)*CREDIT_SCALE,Date.now());};
 return{sqlite,DB,env,ctx,tasks,grant,migrate};
}
const request=(model,id,kind='chat',messages=[{role:'user',content:'hello'}],feature)=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':kind,'x-tochat-message-id':id,'x-tochat-request-id':crypto.randomUUID(),...(feature?{'x-tora-feature':feature}:{})},body:JSON.stringify({model,messages,max_tokens:256})});
const stream=(tools=[])=>new Response('data: '+JSON.stringify({choices:[{delta:tools.length?{tool_calls:tools}:{content:'OK'},finish_reason:tools.length?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});

test('截图中的全部套餐门槛适用于所有模式；到期和取消立即失去权限',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return stream();});
 const expected={'gpt-6.1-sol':1,'gpt-6-sol':1,'gpt-6-luna':1,'grok-4.7':1,'glm-5.3':1,'gemini-3.8-flash':1,'deepseek-flash':1,'claude-sonnet-5-5':2,'claude-haiku-5-5':2,'gpt-6-astra':3,'claude-opus-5-5':3};
 for(const [rank,plan]of ['plus','pro','max5','max20','ultra','ultrax'].entries()){
  f.grant(plan);
  const catalog=await(await handleToChat(new Request('https://test/tochat/quota'),f.env,f.ctx,{id:1})).json();
  for(const[model,min]of Object.entries(expected)){
   assert.equal(catalog.models.find(m=>m.id===model).allowed,rank+1>=min,plan+':'+model);
   assert.equal(catalog.models.find(m=>m.id===model).minimumPlan,MODEL_MINIMUM_PLAN[model]);
   if(rank+1<min)for(const[kind,feature]of [['chat','work'],['work','work'],['work','tocode']]){
    const before=calls,response=await handleToChat(request(model,crypto.randomUUID(),kind,undefined,feature),f.env,f.ctx,{id:1});
    assert.equal(response.status,403);assert.equal((await response.json()).requiredPlan,MODEL_MINIMUM_PLAN[model]);assert.equal(calls,before);
   }
  }
 }
 f.grant('ultrax',1,Date.now()-1);
 assert.equal((await handleToChat(request('gpt-6-astra','expired-model'),f.env,f.ctx,{id:1})).status,403);
 assert.equal(hasModelSubscription('unknown',{planId:'ultrax'}),false);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n,0);
});

test('已有未订阅账号只补发一次，新账号自动获得体验，已有订阅账号不补发',async t=>{
 const future=Date.now()+86400000,past=Date.now()-86400000;
 const f=fixture(`INSERT INTO user_subscription VALUES(2,'plus',${future},500000000,1600000000,7000000000,0); INSERT INTO user_subscription VALUES(3,'pro',${past},1000000000,3200000000,0,0);`);t.after(()=>f.sqlite.close());
 assert.equal((await readToChatQuota(f.DB,1)).trial.remaining,5);assert.equal((await readToChatQuota(f.DB,2)).trial.remaining,0);assert.equal((await readToChatQuota(f.DB,3)).trial.remaining,5);
 f.sqlite.exec('UPDATE user_subscription SET expires_at=0 WHERE user_id=2');f.migrate();assert.equal((await readToChatQuota(f.DB,2)).trial.total,0);
 f.sqlite.exec('INSERT INTO users VALUES(4)');assert.equal((await readToChatQuota(f.DB,4)).trial.remaining,5);
 f.migrate();assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM model_trial_accounts WHERE user_id=4').get().n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards').get().n,0,'体验次数不发放重置卡');
});

test('五次体验跨聊天、工作、ToCode共用，同一消息工具续步不重复扣且不能重用完成标识',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());let toolRound=false,upstream=0;
 t.mock.method(globalThis,'fetch',async()=>{upstream++;return stream(toolRound?[{id:'trial-tool',type:'function',function:{name:'Read',arguments:'{}'}}]:[]);});
 for(let i=0;i<5;i++){
  toolRound=i===4;const response=await handleToChat(request('deepseek-flash','trial-turn-'+i,i%2?'chat':'work',undefined,i%2?'work':'tocode'),f.env,f.ctx,{id:1});
  assert.equal(response.status,200);await response.text();await Promise.all(f.tasks);
  assert.equal((await readToChatQuota(f.DB,1)).trial.remaining,4-i);
 }
 const before=upstream;assert.equal((await handleToChat(request('deepseek-flash','sixth-turn'),f.env,f.ctx,{id:1})).status,403);assert.equal(upstream,before);
 toolRound=false;
 const continuation=await handleToChat(request('deepseek-flash','trial-turn-4','work',[{role:'user',content:'hello'},{role:'assistant',content:null,tool_calls:[{id:'trial-tool',type:'function',function:{name:'Read',arguments:'{}'}}]},{role:'tool',tool_call_id:'trial-tool',content:'result'}],'tocode'),f.env,f.ctx,{id:1});
 assert.equal(continuation.status,200);await continuation.text();await Promise.all(f.tasks);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM model_trial_turns').get().n,5);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n,0,'免费体验不消耗订阅 Credits');
 assert.equal((await handleToChat(request('deepseek-flash','trial-turn-4','work'),f.env,f.ctx,{id:1})).status,409);
 f.grant('plus');const paid=await handleToChat(request('deepseek-flash','paid-after-trial','work'),f.env,f.ctx,{id:1});assert.equal(paid.status,200);await paid.text();await Promise.all(f.tasks);
 assert.equal((await readToChatQuota(f.DB,1)).trial.remaining,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n,1);
});

test('体验预留和请求锁在同一事务，并发拒绝不占次数，累计最多五次',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const reserve=i=>reserveToChat(f.DB,{userId:1,messageId:'parallel-'+i,requestId:'request-'+i,kind:'chat',fingerprint:'same',reserved:0,trial:{fingerprint:'same'}});
 const results=await Promise.allSettled(Array.from({length:6},(_,i)=>reserve(i)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.match(results.find(r=>r.status==='rejected').reason.message,/CONCURRENT_LIMIT/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM model_trial_turns').get().n,2);
 for(let i=0;i<2;i++)await settleToChat(f.DB,{userId:1,messageId:'parallel-'+i,requestId:'request-'+i,usage:{prompt_tokens:1,completion_tokens:1}});
 for(let i=2;i<5;i++){await reserve(i);await settleToChat(f.DB,{userId:1,messageId:'parallel-'+i,requestId:'request-'+i,usage:{prompt_tokens:1,completion_tokens:1}});}
 await assert.rejects(reserve(5),/MODEL_TRIAL_EXHAUSTED/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM model_trial_turns').get().n,5);
 await assert.rejects(reserve(0),/TURN_BUSY_OR_DONE|UNIQUE/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM model_trial_turns').get().n,5);
 const retry=()=>reserveToChat(f.DB,{userId:1,messageId:'parallel-0',requestId:'reused-message',kind:'work',fingerprint:'id',reserved:0,trial:{fingerprint:'different'}});
 await assert.rejects(retry(),/MODEL_TRIAL_ID_REUSED/);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM tochat_requests WHERE request_id IN ('request-5','reused-message')").get().n,0);
});

test('免费豆包不要求套餐、不扣体验，仍然禁止工作和ToCode',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 const model='doubao-seed-2-1-lite-260915';
 const quota=await(await handleToChat(new Request('https://test/tochat/quota'),f.env,f.ctx,{id:1})).json();assert.equal(quota.models.find(m=>m.id===model).allowed,true);
 assert.equal((await handleToChat(request(model,'doubao-work','work'),f.env,f.ctx,{id:1})).status,400);
 assert.equal((await handleToChat(request(model,'doubao-code','chat',undefined,'tocode'),f.env,f.ctx,{id:1})).status,403);
 assert.equal((await readToChatQuota(f.DB,1)).trial.remaining,5);
});


test('明确的首轮上游失败不扣体验，未知断线保留次数以防重复占用',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());
 t.mock.method(globalThis,'fetch',async()=>new Response('unavailable',{status:503}));
 assert.equal((await handleToChat(request('deepseek-flash','failed-trial'),f.env,f.ctx,{id:1})).status,502);
 assert.equal((await readToChatQuota(f.DB,1)).trial.remaining,5);
 t.mock.method(globalThis,'fetch',async()=>{throw Error('network');});
 assert.equal((await handleToChat(request('deepseek-flash','unknown-trial'),f.env,f.ctx,{id:1})).status,502);
 assert.equal((await readToChatQuota(f.DB,1)).trial.remaining,4);
});

test('未订阅账号不能伪造请求绕过任何套餐门槛，付费额度耗尽不能借体验继续工作',async t=>{
 const f=fixture();t.after(()=>f.sqlite.close());let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return stream();});
 for(const model of Object.keys(MODEL_MINIMUM_PLAN).filter(m=>m!=='deepseek-flash'&&!m.startsWith('doubao'))){
  for(const[kind,feature]of [['chat','work'],['work','work'],['work','tocode']])assert.equal((await handleToChat(request(model,crypto.randomUUID(),kind,undefined,feature),f.env,f.ctx,{id:1})).status,403);
 }
 assert.equal(calls,0);assert.equal((await readToChatQuota(f.DB,1)).trial.remaining,5);
 f.grant('plus');f.sqlite.exec('UPDATE user_subscription SET five_hour_limit=1,week_limit=1,month_limit=1 WHERE user_id=1');
 f.sqlite.prepare('INSERT INTO usage_log(user_id,request_id,model,feature,held_micro,created_at) VALUES(?,?,?,?,?,?)').run(1,'paid-budget-held','deepseek-flash','work',1,Date.now());
 assert.equal((await handleToChat(request('deepseek-flash','paid-depleted','work'),f.env,f.ctx,{id:1})).status,429);
 assert.equal((await readToChatQuota(f.DB,1)).trial.remaining,5);assert.equal(calls,0);
});
