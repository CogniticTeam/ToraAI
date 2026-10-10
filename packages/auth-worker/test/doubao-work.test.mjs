import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleToChat,quotaPeriods,reserveToChat,settleToChat,readToChatQuota} from '../src/tochat.js';
import {doubaoWorkCost,DOUBAO_WORK_TURNS,DOUBAO_WORK_BUDGET_NANO,DOUBAO_WORK_ROUNDS} from '../src/doubao-work.js';
import {verificationSessionStatement} from '../src/human-verification.js';
const model='doubao-seed-2-1-lite-260915';
function fixture(t){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO users VALUES(1),(2);');
 for(const name of ['0003_subscriptions.sql','0004_quota_resets.sql','0008_model_access_trials.sql','0009_human_verification.sql','0010_doubao_work.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const DB={prepare(sql){return{bind(...args){return{run:()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}}),first:()=>sqlite.prepare(sql).get(...args)||null,all:()=>({results:sqlite.prepare(sql).all(...args)})};}};},async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>s.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const tasks=[],env={DB,ARK_API_KEY:'synthetic-ark-only',TURNSTILE_DEV_BYPASS:'1'},ctx={waitUntil:p=>tasks.push(p)};
 t.after(()=>sqlite.close());return {DB,sqlite,env,ctx,tasks};
}
const request=(id,{kind='work',feature='work',messages=[{role:'user',content:'Read the test fixture'}],max_tokens=256}={})=>new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-mode':kind,'x-tora-feature':feature,'x-tochat-message-id':id,'x-tochat-request-id':crypto.randomUUID()},body:JSON.stringify({model,messages,max_tokens,tools:kind==='work'?[{type:'function',function:{name:'Read',parameters:{type:'object'}}}]:undefined})});
const stream=(tool=false)=>new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:tool?[{type:'function_call',call_id:'read-fixture',name:'Read',arguments:'{}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'DOUBAO_WORK_OK'}]}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
async function consume(f,response){assert.equal(response.status,200);await response.text();await Promise.all(f.tasks);}

test('free work accepts tools for unsubscribed and subscribed users, clamps output, never charges Credits or DeepSeek trials',async t=>{
 const f=fixture(t);let outgoing;
 t.mock.method(globalThis,'fetch',async(url,init)=>{outgoing=JSON.parse(init.body);assert.equal(url,'https://ark.cn-beijing.volces.com/api/v3/responses');return stream();});
 await consume(f,await handleToChat(request('free-work-first',{max_tokens:16000}),f.env,f.ctx,{id:1}));
 await settleToChat(f.DB,{userId:1,messageId:'free-work-first',requestId:f.sqlite.prepare("SELECT request_id FROM doubao_work_requests WHERE user_id=1").get().request_id,doubaoWork:true,failed:true});
 assert.equal((await readToChatQuota(f.DB,1)).doubaoWork.used,1);
 assert.equal(outgoing.max_output_tokens,4096);assert.equal(outgoing.tools[0].name,'Read');
 f.sqlite.prepare('INSERT INTO user_subscription VALUES(?,?,?,?,?,?,?)').run(2,'plus',Date.now()+86400000,500,1000,2000,Date.now());
 await consume(f,await handleToChat(request('paid-free-work'),f.env,f.ctx,{id:2}));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM model_trial_turns').get().n,0);
 assert.equal((await readToChatQuota(f.DB,1)).doubaoWork.remaining,9);
 assert.equal((await readToChatQuota(f.DB,2)).doubaoWork.remaining,9);
 assert.equal((await handleToChat(request('code-rejected',{feature:'tocode'}),f.env,f.ctx,{id:1})).status,403);
 const list=await(await handleToChat(new Request('https://test/tochat/v1/models',{headers:{'x-tora-feature':'tocode'}}),f.env,f.ctx,{id:1})).json();assert.deepEqual(list.data,[]);
});

test('ten sends count separately, tool continuation counts once, completed IDs and missing results cannot bypass limits',async t=>{
 const f=fixture(t);let tool=true,calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return stream(tool);});
 await consume(f,await handleToChat(request('one-tool-message'),f.env,f.ctx,{id:1}));
 assert.equal((await readToChatQuota(f.DB,1)).doubaoWork.used,1);
 assert.equal((await handleToChat(request('one-tool-message'),f.env,f.ctx,{id:1})).status,409);
 const history=[{role:'user',content:'Read the test fixture'},{role:'assistant',content:null,tool_calls:[{id:'read-fixture',type:'function',function:{name:'Read',arguments:'{}'}}]},{role:'tool',tool_call_id:'read-fixture',content:'fixture data'}];
 tool=false;await consume(f,await handleToChat(request('one-tool-message',{messages:history}),f.env,f.ctx,{id:1}));
 assert.equal((await readToChatQuota(f.DB,1)).doubaoWork.used,1);
 assert.equal((await handleToChat(request('one-tool-message',{messages:history}),f.env,f.ctx,{id:1})).status,409);
 for(let i=1;i<10;i++)await consume(f,await handleToChat(request('new-work-message-'+i),f.env,f.ctx,{id:1}));
 const before=calls,denied=await handleToChat(request('eleventh-message'),f.env,f.ctx,{id:1});assert.equal(denied.status,429);assert.equal((await denied.json()).code,'doubao_work_limit');assert.equal(calls,before);
 const quota=await(await handleToChat(new Request('https://test/tochat/quota'),f.env,f.ctx,{id:1})).json();assert.equal(quota.doubaoWork.remaining,0);assert.equal(quota.models.find(m=>m.id===model).allowed,true);assert.equal(quota.models.find(m=>m.id===model).workAllowed,false);
 await consume(f,await handleToChat(request('chat-still-free',{kind:'chat'}),f.env,f.ctx,{id:1}));
 assert.equal((await readToChatQuota(f.DB,1)).doubaoWork.used,10);
});

test('atomic daily-count, budget, round and content guards roll back all failed reservations',async t=>{
 const f=fixture(t),now=Date.parse('2026-10-10T12:00:00Z');
 const reserve=(messageId,requestId,cost=1000,userId=1,time=now,fingerprint='same')=>reserveToChat(f.DB,{userId,messageId,requestId,kind:'work',fingerprint:'work',reserved:0,now:time,doubaoWork:{cost,fingerprint}});
 for(let i=0;i<9;i++){await reserve('turn-'+i,'request-'+i);await settleToChat(f.DB,{userId:1,messageId:'turn-'+i,requestId:'request-'+i,doubaoWork:true,usage:{total_tokens:1}});}
 const races=await Promise.allSettled([reserve('last-turn-a','last-request-a'),reserve('last-turn-b','last-request-b')]);assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM doubao_work_turns WHERE user_id=1').get().n,DOUBAO_WORK_TURNS);
 await reserve('budget-first','budget-request-first',120000000,2);
 await assert.rejects(reserve('budget-second','budget-request-second',120000000,2),/BUDGET_LIMIT/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM doubao_work_turns WHERE user_id=2').get().n,1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM tochat_turns WHERE user_id=2').get().n,1);
 for(let i=0;i<DOUBAO_WORK_ROUNDS;i++){await reserve('round-turn','round-request-'+i,1000,3);await settleToChat(f.DB,{userId:3,messageId:'round-turn',requestId:'round-request-'+i,doubaoWork:true,usage:{total_tokens:1},tools:['tool-id']});}
 await assert.rejects(reserve('round-turn','round-exceeded',1000,3),/ROUND_LIMIT/);
 await assert.rejects(reserve('round-turn','changed-content',1000,3,now,'different'),/ID_REUSED/);
 assert.equal(f.sqlite.prepare('SELECT rounds FROM tochat_turns WHERE user_id=3').get().rounds,8);
 assert.equal(DOUBAO_WORK_BUDGET_NANO,200000000);assert.equal(doubaoWorkCost(100000,1000),82700000);assert.ok(doubaoWorkCost(100000,1000,true)>DOUBAO_WORK_BUDGET_NANO);
});

test('GMT+8 midnight restores daily allowances without resetting subscription credits; only confirmed failures refund',async t=>{
 const f=fixture(t),before=Date.parse('2026-10-10T15:59:59Z'),after=Date.parse('2026-10-10T16:00:00Z');
 const reserve=(messageId,requestId,time)=>reserveToChat(f.DB,{userId:1,messageId,requestId,kind:'work',fingerprint:'work',reserved:0,now:time,doubaoWork:{cost:120000000,fingerprint:'same'}});
 await reserve('before-midnight','before-midnight-request',before);await settleToChat(f.DB,{userId:1,messageId:'before-midnight',requestId:'before-midnight-request',doubaoWork:true,unknown:true});
 assert.equal((await readToChatQuota(f.DB,1,before)).doubaoWork.used,1);assert.equal((await readToChatQuota(f.DB,1,after)).doubaoWork.used,0);
 assert.equal(quotaPeriods(before).dailyReset,'2026-10-10T16:00:00.000Z');
 await reserve('after-midnight','after-midnight-request',after);await settleToChat(f.DB,{userId:1,messageId:'after-midnight',requestId:'after-midnight-request',doubaoWork:true,failed:true});
 assert.equal((await readToChatQuota(f.DB,1,after)).doubaoWork.used,0);
 assert.equal(f.sqlite.prepare('SELECT cost_nano FROM doubao_work_requests WHERE request_id=?').get('before-midnight-request').cost_nano,120000000);
 assert.equal(f.sqlite.prepare('SELECT cost_nano FROM doubao_work_requests WHERE request_id=?').get('after-midnight-request').cost_nano,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n,0);
});

test('free-work connection failures preserve the budget; rejected upstream requests refund and do not leak keys',async t=>{
 const f=fixture(t);t.mock.method(globalThis,'fetch',async()=>new Response('synthetic-ark-only',{status:500}));
 assert.equal((await handleToChat(request('vendor-rejected'),f.env,f.ctx,{id:1})).status,502);
 assert.equal((await readToChatQuota(f.DB,1)).doubaoWork.used,0);
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('connection failed');});
 assert.equal((await handleToChat(request('unknown-request'),f.env,f.ctx,{id:1})).status,502);
 assert.equal((await readToChatQuota(f.DB,1)).doubaoWork.used,1);
 assert.equal(f.sqlite.prepare("SELECT status FROM doubao_work_requests WHERE message_id='unknown-request'").get().status,'unknown');
});

test('unsubscribed free-work requires verification; verified tool continuation survives expiry, and paid users skip repeated challenges',async t=>{
 const f=fixture(t);delete f.env.TURNSTILE_DEV_BYPASS;f.env.TURNSTILE_SECRET='synthetic-verification-secret';let tool=true,calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return stream(tool);});
 const req=(id,opts)=>{const r=request(id,opts);r.headers.set('authorization','Bearer synthetic-session');return r;};
 assert.equal((await handleToChat(req('unverified-work'),f.env,f.ctx,{id:1})).status,403);assert.equal(calls,0);
 await f.DB.batch([await verificationSessionStatement(f.DB,'synthetic-session',1)]);
 await consume(f,await handleToChat(req('verified-work'),f.env,f.ctx,{id:1}));
 f.sqlite.exec('UPDATE human_verification_sessions SET expires_at=0');tool=false;
 const messages=[{role:'user',content:'Read the test fixture'},{role:'assistant',content:null,tool_calls:[{id:'read-fixture',type:'function',function:{name:'Read',arguments:'{}'}}]},{role:'tool',tool_call_id:'read-fixture',content:'data'}];
 await consume(f,await handleToChat(req('verified-work',{messages}),f.env,f.ctx,{id:1}));
 assert.equal((await handleToChat(req('expired-new-work'),f.env,f.ctx,{id:1})).status,403);
 f.sqlite.prepare('INSERT INTO user_subscription VALUES(?,?,?,?,?,?,?)').run(2,'plus',Date.now()+86400000,500,1000,2000,Date.now());
 await consume(f,await handleToChat(req('paid-no-challenge'),f.env,f.ctx,{id:2}));
});
