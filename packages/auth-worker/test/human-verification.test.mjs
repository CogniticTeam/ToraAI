import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {verifyTurnstile,readHumanVerification,handleHumanVerification,HUMAN_VERIFICATION_TTL} from '../src/human-verification.js';
import {handleToChat} from '../src/tochat.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2);');
 for(const name of ['0003_subscriptions.sql','0004_quota_resets.sql','0008_model_access_trials.sql','0009_human_verification.sql'])sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare(query){const statement=args=>({bind:(...v)=>statement(v),first:async()=>sql.prepare(query).get(...args)||null,all:async()=>({results:sql.prepare(query).all(...args)}),run:async()=>({meta:sql.prepare(query).run(...args)})});return statement([]);},async batch(items){sql.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB,TURNSTILE_SECRET:'fixture-only-secret',TURNSTILE_HOSTNAMES:'fixture.invalid',DEEPSEEK_API_KEY:'fixture-model-key'};return{sql,DB,env};
}
const humanRequest=(token='browser-session-1',proof)=>new Request('https://test/auth/human-verification',{method:proof===undefined?'GET':'POST',headers:{authorization:'Bearer '+token},...(proof===undefined?{}:{body:JSON.stringify({'cf-turnstile-response':proof})})});
const completion=(id,token='browser-session-1',messages=[{role:'user',content:'hello'}])=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'x-tochat-mode':'work','x-tora-feature':'tocode','x-tochat-message-id':id,'x-tochat-request-id':crypto.randomUUID()},body:JSON.stringify({model:'deepseek-flash',messages,max_tokens:256,humanVerification:{verified:true}})});
function modelResponse(tool=false){return new Response('data: '+JSON.stringify({choices:[{delta:tool?{tool_calls:[{id:'verified-tool',type:'function',function:{name:'Read',arguments:'{}'}}]}:{content:'OK'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}})+'\n\ndata: [DONE]\n\n');}

test('Siteverify 核对成功、动作、域名和失败；未配置密钥默认拒绝',async t=>{
 const{sql,env}=fixture();t.after(()=>sql.close());const req=humanRequest();let outcome={success:true,action:'free_trial',hostname:'fixture.invalid'},calls=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');assert.equal(init.body.get('secret'),env.TURNSTILE_SECRET);return Response.json(outcome);});
 assert.equal(await verifyTurnstile(env,req,'proof','free_trial'),true);
 for(const result of [{success:false,action:'free_trial',hostname:'fixture.invalid'},{success:true,action:'login',hostname:'fixture.invalid'},{success:true,action:'free_trial',hostname:'other.invalid'}]){outcome=result;assert.equal(await verifyTurnstile(env,req,'proof','free_trial'),false);}
 assert.equal(await verifyTurnstile(env,req,'','free_trial'),false);assert.equal(await verifyTurnstile(env,req,'x'.repeat(2049),'free_trial'),false);assert.equal(calls,4);
 assert.equal(await verifyTurnstile({},req,'proof','login'),false);
 assert.equal(await verifyTurnstile({TURNSTILE_DEV_BYPASS:'1'},req,'','login'),true);
 t.mock.method(globalThis,'fetch',async()=>{throw Error('offline');});assert.equal(await verifyTurnstile(env,req,'proof','free_trial'),false);
});

test('验证记录只绑定当前账号和登录会话，30分钟到期且拒绝过期或重复令牌',async t=>{
 const{sql,env}=fixture();t.after(()=>sql.close());let used=false;
 t.mock.method(globalThis,'fetch',async()=>Response.json(used?{success:false,'error-codes':['timeout-or-duplicate']}:(used=true,{success:true,action:'free_trial',hostname:'fixture.invalid'})));
 assert.equal((await handleHumanVerification(humanRequest(),env,null)).status,401);
 assert.equal((await handleHumanVerification(humanRequest('browser-session-1','proof'),env,{id:1,banned:1})).status,403);
 assert.equal((await readHumanVerification(env,humanRequest(),1)).verified,false);
 assert.equal((await handleHumanVerification(humanRequest('browser-session-1','proof'),env,{id:1})).status,200);
 const row=sql.prepare('SELECT * FROM human_verification_sessions').get();assert.equal(row.expires_at-row.verified_at,HUMAN_VERIFICATION_TTL);assert.notEqual(row.token_hash,'browser-session-1');
 assert.equal((await readHumanVerification(env,humanRequest(),1)).verified,true);
 assert.equal((await readHumanVerification(env,humanRequest('browser-session-2'),1)).verified,false);
 assert.equal((await readHumanVerification(env,humanRequest(),2)).verified,false);
 assert.equal((await readHumanVerification(env,humanRequest(),1,row.expires_at)).verified,false);
 assert.equal((await handleHumanVerification(humanRequest('browser-session-2','proof'),env,{id:1})).status,403);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM human_verification_sessions').get().n,1);
});

test('免费体验未校验不扣次数、不调用模型；过期后已开始的工具续步可结束，新消息必须再验证',async t=>{
 const{sql,env}=fixture();t.after(()=>sql.close());const tasks=[],ctx={waitUntil:p=>tasks.push(p)};let modelCalls=0,tool=true;
 t.mock.method(globalThis,'fetch',async url=>{if(url.includes('siteverify'))return Response.json({success:true,action:'free_trial',hostname:'fixture.invalid'});modelCalls++;return modelResponse(tool);});
 const denied=await handleToChat(completion('before-verified'),env,ctx,{id:1});assert.equal(denied.status,403);assert.equal((await denied.json()).code,'human_verification_required');assert.equal(modelCalls,0);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_trial_turns').get().n,0);
 await handleHumanVerification(humanRequest('browser-session-1','fixture-proof'),env,{id:1});
 const first=await handleToChat(completion('verified-turn'),env,ctx,{id:1});assert.equal(first.status,200);await first.text();await Promise.all(tasks);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_trial_turns').get().n,1);
 sql.exec('UPDATE human_verification_sessions SET expires_at=0');tool=false;
 const messages=[{role:'user',content:'hello'},{role:'assistant',tool_calls:[{id:'verified-tool',type:'function',function:{name:'Read',arguments:'{}'}}],content:null},{role:'tool',tool_call_id:'verified-tool',content:'result'}];
 assert.equal((await handleToChat(completion('verified-turn','other-session',messages),env,ctx,{id:1})).status,403);
 const continued=await handleToChat(completion('verified-turn','browser-session-1',messages),env,ctx,{id:1});assert.equal(continued.status,200);await continued.text();await Promise.all(tasks);assert.equal(modelCalls,2);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_trial_turns').get().n,1);
 assert.equal((await handleToChat(completion('new-unverified-turn'),env,ctx,{id:1})).status,403);assert.equal(modelCalls,2);
});

test('付费订阅使用模型不反复验证，缺少验证服务时不能激活免费体验',async t=>{
 const{sql,env}=fixture();t.after(()=>sql.close());const now=Date.now();sql.prepare('INSERT INTO user_subscription VALUES(?,?,?,?,?,?,?)').run(1,'plus',now+86400000,500000000,1600000000,7000000000,now);
 const tasks=[];t.mock.method(globalThis,'fetch',async()=>modelResponse(false));
 const response=await handleToChat(completion('paid-humanless'),env,{waitUntil:p=>tasks.push(p)},{id:1});assert.equal(response.status,200);await response.text();await Promise.all(tasks);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM human_verification_sessions').get().n,0);
 assert.equal((await handleHumanVerification(humanRequest('browser-session-2','proof'),{DB:env.DB},{id:2})).status,503);
});
