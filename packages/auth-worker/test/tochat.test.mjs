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
