import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {handleAdminQuota,handleUserQuota} from '../src/quota-management.js';import {readAgentQuota,reserveCreditStatement,settleCredit} from '../src/agent-credits.js';import {WINDOWS} from '../src/subscription-plans.js';
function fixture(){const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2),(3); CREATE TABLE admin_audit(id INTEGER PRIMARY KEY,action TEXT,user_id INTEGER,detail TEXT,created_at TEXT);');for(const file of ['0003_subscriptions.sql','0004_quota_resets.sql','0006_new_user_reset_cards.sql'])sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));const db={prepare(query){const q=sql.prepare(query);return{bind(...args){return{run:()=>({meta:{changes:q.run(...args).changes}}),first:()=>q.get(...args)||null,all:()=>({results:q.all(...args)})};}};},async batch(items){sql.exec('BEGIN');try{const r=items.map(item=>item.run());sql.exec('COMMIT');return r;}catch(error){sql.exec('ROLLBACK');throw error;}}};return{sql,db,env:{DB:db}};}
const admin=(env,kind,body)=>handleAdminQuota(new Request('https://test/admin/quota/'+kind,{method:'POST',body:JSON.stringify(body)}),env);const user=(env,id,path,body)=>handleUserQuota(new Request('https://test/quota/'+path,body?{method:'POST',body:JSON.stringify(body)}:undefined),env,{id});
async function grant(env,scope='all',userIds=[]){const r=await admin(env,'subscription',{scope,userIds,planId:'plus',days:30,operationId:crypto.randomUUID()});assert.equal(r.status,200);}
async function spend(db,id,requestId,now=Date.now()){await db.batch([reserveCreditStatement(db,{userId:id,requestId,model:'gpt-6.1-sol',feature:'tocode',reserved:500000000,now})]);await settleCredit(db,{userId:id,requestId,model:'gpt-6.1-sol',unknown:true});}
test('admin single/multiple/all reset preserves ledger and reanchors all windows',async()=>{const{sql,db,env}=fixture();await grant(env);for(const id of [1,2,3])await spend(db,id,'before-'+id);assert.equal((await readAgentQuota(db,1)).remainingPercent,0);await admin(env,'reset',{scope:'selected',userIds:[1],operationId:'reset-one-123'});assert.equal((await readAgentQuota(db,1)).remainingPercent,100);assert.equal((await readAgentQuota(db,2)).remainingPercent,0);const state=sql.prepare('SELECT reset_at FROM quota_reset_state WHERE user_id=1').get();assert.equal((await readAgentQuota(db,1)).windows[0].resetAt,new Date(state.reset_at+WINDOWS.fiveHour).toISOString());await admin(env,'reset',{scope:'selected',userIds:[2,3],operationId:'reset-multi-123'});assert.equal((await readAgentQuota(db,2)).remainingPercent,100);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n,3);await spend(db,1,'after',state.reset_at);await assert.rejects(db.batch([reserveCreditStatement(db,{userId:1,requestId:'over',model:'gpt-6.1-sol',feature:'tocode',reserved:1,now:Date.now()})]),/CREDIT_LIMIT/);await admin(env,'reset',{scope:'all',operationId:'reset-all-123'});assert.equal((await readAgentQuota(db,1)).remainingPercent,100);sql.close();});
test('cards expire at 30 days, are account-bound, and are consumed atomically once',async()=>{const{sql,db,env}=fixture();await grant(env);const issuance={scope:'all',count:2,operationId:'issue-cards-123'};assert.equal((await admin(env,'cards',issuance)).status,200);assert.equal((await admin(env,'cards',issuance)).status,200);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards').get().n,6);const card=sql.prepare('SELECT * FROM quota_reset_cards WHERE user_id=1 LIMIT 1').get();assert.equal(card.expires_at-card.issued_at,WINDOWS.month);await spend(db,1,'before-card');assert.equal((await user(env,2,'cards/use',{cardId:card.id})).status,409);assert.equal((await user(env,1,'cards/use',{cardId:card.id})).status,200);assert.equal((await readAgentQuota(db,1)).remainingPercent,100);assert.equal((await user(env,1,'cards/use',{cardId:card.id})).status,409);const other=sql.prepare('SELECT id FROM quota_reset_cards WHERE user_id=1 AND used_at IS NULL').get();sql.prepare('UPDATE quota_reset_cards SET expires_at=? WHERE id=?').run(Date.now()-1,other.id);assert.equal((await user(env,1,'cards/use',{cardId:other.id})).status,409);const data=await(await user(env,1,'overview')).json();assert.ok(data.cards.some(c=>c.status==='expired'));assert.equal(data.history.length,1);sql.close();});
test('active work prevents reset without consuming cards; all-user reset reports skipped users',async()=>{const{sql,db,env}=fixture();await grant(env);await admin(env,'cards',{scope:'selected',userIds:[1],count:1,operationId:'busy-card-123'});await db.batch([reserveCreditStatement(db,{userId:1,requestId:'running',model:'gpt-6.1-sol',feature:'tocode',reserved:1000000,now:Date.now()})]);const card=sql.prepare('SELECT id FROM quota_reset_cards WHERE user_id=1').get();assert.equal((await user(env,1,'cards/use',{cardId:card.id})).status,409);assert.equal(sql.prepare('SELECT used_at FROM quota_reset_cards').get().used_at,null);const reset=await(await admin(env,'reset',{scope:'all',operationId:'busy-reset-123'})).json();assert.equal(reset.skippedBusyUsers,1);assert.equal(reset.affectedUsers,2);sql.close();});
test('manual subscription is auditable, idempotent and rejects invalid targets and overwriting a higher tier',async()=>{const{sql,env}=fixture();const body={scope:'selected',userIds:[1,2],planId:'pro',days:60,operationId:'grant-pro-123'};assert.equal((await admin(env,'subscription',body)).status,200);const expiry=sql.prepare('SELECT expires_at FROM user_subscription WHERE user_id=1').get().expires_at;assert.equal(sql.prepare('SELECT month_limit FROM user_subscription WHERE user_id=1').get().month_limit,0);await admin(env,'subscription',body);assert.equal(sql.prepare('SELECT expires_at FROM user_subscription WHERE user_id=1').get().expires_at,expiry);assert.equal((await admin(env,'subscription',{...body,operationId:'invalid-target-123',userIds:[999]})).status,400);assert.equal((await admin(env,'subscription',{...body,operationId:'lower-target-123',planId:'plus'})).status,409);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n,1);assert.equal((await handleUserQuota(new Request('https://test/quota/overview'),env,null)).status,401);sql.close();});


test('取消订阅支持单人、多人和全部用户，立即拦截新消耗并保留历史',async()=>{
 const{sql,db,env}=fixture();await grant(env);await spend(db,1,'retained-usage');
 await admin(env,'cards',{scope:'all',count:1,operationId:'keep-cards-123'});
 const one={scope:'selected',userIds:[1],operationId:'cancel-one-123'};
 const result=await(await admin(env,'cancel-subscription',one)).json();assert.equal(result.affectedUsers,1);
 assert.equal((await readAgentQuota(db,1)).subscription,null);
 assert.ok((await readAgentQuota(db,2)).subscription);
 await assert.rejects(db.batch([reserveCreditStatement(db,{userId:1,requestId:'after-cancel',model:'gpt-6.1-sol',feature:'tocode',reserved:1,now:Date.now()})]),/SUBSCRIPTION_REQUIRED/);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n,1);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards').get().n,3);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM user_subscription').get().n,3);
 assert.equal((await(await admin(env,'cancel-subscription',one)).json()).replayed,true);
 await grant(env,'selected',[1]);
 await admin(env,'cancel-subscription',one);assert.ok((await readAgentQuota(db,1)).subscription,'旧请求重试不能撤销重新开通的订阅');
 const multi=await(await admin(env,'cancel-subscription',{scope:'selected',userIds:[1,2],operationId:'cancel-multi-123'})).json();assert.equal(multi.affectedUsers,2);
 const all=await(await admin(env,'cancel-subscription',{scope:'all',operationId:'cancel-all-123'})).json();assert.equal(all.affectedUsers,1);
 assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='quota-cancel-subscription'").get().n,3);
 assert.equal((await(await admin(env,'cancel-subscription',{scope:'all',operationId:'cancel-none-123'})).json()).affectedUsers,0);
 sql.close();
});

test('取消订阅拒绝无效目标和重复标识冲突；不撤销无关用户',async()=>{
 const{sql,db,env}=fixture();await grant(env);
 for(const userIds of [[],[999],['1'],[1,999]])assert.equal((await admin(env,'cancel-subscription',{scope:'selected',userIds,operationId:crypto.randomUUID()})).status,400);
 const body={scope:'selected',userIds:[1],operationId:'cancel-conflict-123'};
 await admin(env,'cancel-subscription',body);
 assert.equal((await admin(env,'cancel-subscription',{...body,userIds:[2]})).status,400);
 assert.ok((await readAgentQuota(db,2)).subscription);sql.close();
});

test('新注册用户原子获得一张30天卡；迁移和更新不会给旧用户补发或重复发卡',async()=>{
 const{sql,env}=fixture();assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards').get().n,0);
 const before=Date.now();sql.exec('INSERT INTO users VALUES(4)');
 let cards=sql.prepare('SELECT * FROM quota_reset_cards WHERE user_id=4').all();assert.equal(cards.length,1);
 assert.equal(cards[0].expires_at-cards[0].issued_at,WINDOWS.month);
 assert.ok(cards[0].issued_at>=before-1000 && cards[0].issued_at<=Date.now());
 assert.equal(cards[0].operation_id,'new-user-registration');assert.match(cards[0].id,/^[a-f0-9]{32}$/);
 sql.exec(readFileSync(new URL('../migrations/0006_new_user_reset_cards.sql',import.meta.url),'utf8'));
 sql.exec('UPDATE users SET id=id WHERE id=4');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards').get().n,1);
 assert.throws(()=>sql.exec('INSERT INTO users VALUES(4)'),/UNIQUE/);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards').get().n,1);
 sql.exec('BEGIN; INSERT INTO users VALUES(5); ROLLBACK;');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards WHERE user_id=5').get().n,0);
 assert.equal((await user(env,4,'cards/use',{cardId:cards[0].id})).status,409);
 await grant(env,'selected',[4]);assert.equal((await user(env,4,'cards/use',{cardId:cards[0].id})).status,200);
 assert.equal((await user(env,4,'cards/use',{cardId:cards[0].id})).status,409);sql.close();
});

test('管理端开关只影响未来注册，持久化关闭且保留已发卡',async()=>{
 const{sql,env}=fixture();
 const settings=()=>handleAdminQuota(new Request('https://test/admin/quota/new-user-cards'),env);
 assert.deepEqual(await(await settings()).json(),{enabled:true,count:1,validDays:30});
 sql.exec('INSERT INTO users VALUES(4)');
 assert.equal((await admin(env,'new-user-cards',{enabled:false})).status,200);
 sql.exec(readFileSync(new URL('../migrations/0006_new_user_reset_cards.sql',import.meta.url),'utf8'));
 assert.equal((await(await settings()).json()).enabled,false);
 sql.exec('INSERT INTO users VALUES(5)');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards WHERE user_id=5').get().n,0);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards WHERE user_id=4').get().n,1);
 await admin(env,'new-user-cards',{enabled:true});sql.exec('INSERT INTO users VALUES(6)');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards WHERE user_id=6').get().n,1);
 assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards WHERE user_id=5').get().n,0);
 for(const body of [null,{}, {enabled:'false'},{enabled:0}])assert.equal((await admin(env,'new-user-cards',body)).status,400);
 assert.equal((await(await settings()).json()).enabled,true);
 assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='quota-new-user-cards'").get().n,2);sql.close();
});
