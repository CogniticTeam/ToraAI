import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureEnforcement,measureFairUse,recordRateIncident,readEnforcement,handleAdminEnforcement,handleUserEnforcement,gateOfficialRequest,DAY,FAIR_USE_LIMITS,POLICY_VERSION} from '../src/enforcement.js';
import {AccountEvents} from '../src/account-events.js';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,banned INTEGER DEFAULT 0,ban_reason TEXT DEFAULT '',email TEXT,username TEXT); INSERT INTO users(id,email,username) VALUES(1,'one@example.invalid','One'),(2,'two@example.invalid','Two'); CREATE TABLE user_subscription(user_id INTEGER PRIMARY KEY,expires_at INTEGER); INSERT INTO user_subscription VALUES(1,9999999999999); CREATE TABLE usage_log(user_id INTEGER,credit_micro INTEGER); INSERT INTO usage_log VALUES(1,500); CREATE TABLE quota_reset_cards(id TEXT,user_id INTEGER); INSERT INTO quota_reset_cards VALUES('owned-card',1);");
 const db={prepare(sql){return{bind(...args){return{run(){return{meta:{changes:sqlite.prepare(sql).run(...args).changes}};},first(){return sqlite.prepare(sql).get(...args)||null;},all(){return{results:sqlite.prepare(sql).all(...args)};}};}};},async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 return {sqlite,db,env:{DB:db}};
}
const request=(path,body)=>new Request('https://test'+path,{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
const incident=(db,id,now)=>recordRateIncident(db,{userId:1,signalId:id,rule:'new_turn_burst',evidence:{requests:100,newTurns:61,uniqueRequests:100,windowSeconds:60},now});
test('fair-use counts tool continuations once as a user turn; duplicate retries throttle without strikes; incidents have a ten-minute cooldown',()=>{
 let state={};const now=Date.now();
 for(let i=0;i<100;i++){const decision=measureFairUse(state,{now:now+i,requestHash:'req-'+i,messageHash:'one-turn'});state=decision.state;assert.equal(decision.allowed,true);assert.equal(decision.evidence.newTurns,1);}
 for(let i=0;i<700;i++){const decision=measureFairUse(state,{now:now+1000+i,requestHash:'one-retry',messageHash:'one-turn'});state=decision.state;}
 let retries={};for(let i=0;i<700;i++){const result=measureFairUse(retries,{now:now+i,requestHash:'same',messageHash:'same'});retries=result.state;if(i>600){assert.equal(result.allowed,false);assert.equal(result.incident,false);}}
 let burst={},first;
 for(let i=0;i<70;i++){const result=measureFairUse(burst,{now:now+i,requestHash:'different-'+i,messageHash:'turn-'+i});burst=result.state;if(result.incident){assert.equal(first,undefined);first=result;}}
 assert.equal(first.rule,'new_turn_burst');assert.equal(first.evidence.newTurns,61);
 assert.equal(measureFairUse(burst,{now:now+5000,requestHash:'another',messageHash:'another'},true).incident,false);
 assert.equal(FAIR_USE_LIMITS.requests,600);
});
test('three independent incidents create a seven-day temporary ban, with automatic expiry and no loss of paid data',async()=>{
 const f=fixture(),now=Date.now();try{
  const a=await incident(f.db,'one',now),b=await incident(f.db,'two',now+600000),c=await incident(f.db,'three',now+1200000);
  assert.deepEqual([a.level,b.level,c.level],[1,1,2]);assert.equal(c.ban_until-c.created_at,7*DAY);assert.equal(c.permanent,0);assert.equal((await readEnforcement(f.db,1,now+1200001)).banned,true);
  const after=await readEnforcement(f.db,1,c.ban_until+1);assert.equal(after.banned,false);assert.equal(after.observation,true);
  assert.equal(f.sqlite.prepare('SELECT banned FROM users WHERE id=1').get().banned,0);assert.equal(f.sqlite.prepare('SELECT expires_at FROM user_subscription').get().expires_at,9999999999999);assert.equal(f.sqlite.prepare('SELECT credit_micro FROM usage_log').get().credit_micro,500);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM quota_reset_cards').get().n,1);
  assert.equal((await incident(f.db,'three',now+1200000)).id,c.id);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM enforcement_cases').get().n,3);
 }finally{f.sqlite.close();}
});
test('moderate cases progress through 7/15/30 days; observation cannot automatically become permanent',async()=>{
 const f=fixture();try{let now=Date.now(),last;for(let cycle=0;cycle<3;cycle++){
  for(let i=0;i<3;i++)last=await incident(f.db,'cycle-'+cycle+'-'+i,now+i*600000);
  assert.equal(last.level,2);assert.equal(last.ban_until-last.created_at,[7,15,30][cycle]*DAY);
  if(cycle<2)now=last.observation_until+1;
 }
 const observed=await incident(f.db,'observation-again',last.ban_until+1);assert.equal(observed.level,3);assert.equal(observed.permanent,0);
 const refused=await handleAdminEnforcement(request('/admin/enforcement/cases/'+observed.id+'/review',{action:'permanent',confirmUserId:2,note:'已经核实但账号标识不匹配'}),f.env);assert.equal(refused.status,400);
 assert.equal((await handleAdminEnforcement(request('/admin/enforcement/cases/'+observed.id+'/review',{action:'permanent',confirmUserId:1,note:'人工已核实本案件及账号身份，确认处理'}),f.env)).status,200);assert.equal((await readEnforcement(f.db,1)).permanent,true);
 assert.equal((await handleAdminEnforcement(request('/admin/enforcement/cases/'+observed.id+'/review',{action:'revoke',note:'复核发现误判，撤销对应的自动处理记录'}),f.env)).status,200);assert.equal((await readEnforcement(f.db,1)).permanent,false);
 }finally{f.sqlite.close();}
});
test('appeals are owner-scoped, remain available for bans, reject credentials and revoke only the reviewed case',async()=>{
 const f=fixture();try{
  const item=await incident(f.db,'appeal-case',Date.now());
  assert.equal((await handleUserEnforcement(request('/account/enforcement/appeals',{caseId:item.id,statement:'请求复核这个并非我的处罚事件'}),f.env,{id:2})).status,404);
  assert.equal((await handleUserEnforcement(request('/account/enforcement/appeals',{caseId:item.id,statement:'这是一个示例密钥 sk-abcdefghijklmnopqrstuvxyz'}),f.env,{id:1})).status,400);
  const response=await handleUserEnforcement(request('/account/enforcement/appeals',{caseId:item.id,statement:'这是合法自动化测试，可能误判，请核对计数。'}),f.env,{id:1,banned:1});assert.equal(response.status,200);const appeal=await response.json();
  const repeated=await handleUserEnforcement(request('/account/enforcement/appeals',{caseId:item.id,statement:'补充同一事件的说明，不应重复创建工单'}),f.env,{id:1});assert.equal((await repeated.json()).id,appeal.id);
  assert.equal((await handleAdminEnforcement(request('/admin/enforcement/appeals/'+appeal.id+'/review',{action:'accepted',note:'已经复核，确为正常授权使用，撤销对应记录。'}),f.env)).status,200);assert.equal((await readEnforcement(f.db,1)).limited,false);
  const other=await(await handleUserEnforcement(request('/account/enforcement'),f.env,{id:2})).json();assert.equal(other.cases.length,0);assert.equal(other.appeals.length,0);
 }finally{f.sqlite.close();}
});
test('old manual-ban appeals cannot undo a newer manual ban',async()=>{
 const f=fixture();try{await ensureEnforcement(f.db);f.sqlite.prepare("UPDATE users SET banned=1,ban_reason='manual' WHERE id=1").run();f.sqlite.prepare('INSERT INTO manual_ban_versions VALUES(1,?)').run('first');
  const appeal=await(await handleUserEnforcement(request('/account/enforcement/appeals',{statement:'这是对当前人工处罚的正式申诉说明'}),f.env,{id:1,banned:1})).json();f.sqlite.prepare("UPDATE manual_ban_versions SET version='newer' WHERE user_id=1").run();
  const response=await handleAdminEnforcement(request('/admin/enforcement/appeals/'+appeal.id+'/review',{action:'accepted',note:'虽然之前的理由不成立，但需核对最新记录'}),f.env);assert.equal(response.status,409);assert.equal(f.sqlite.prepare('SELECT banned FROM users').get().banned,1);
 }finally{f.sqlite.close();}
});
test('Durable Object writes metadata-only counters, serializes requests and recovers a pending case exactly once',async()=>{
 const f=fixture();try{const values=new Map(),storage={get:async key=>structuredClone(values.get(key)),put:async(key,value)=>{values.set(key,structuredClone(value));}},object=new AccountEvents({storage},f.env);
  for(let i=0;i<65;i++){const response=await object.fetch(request('/fair-use',{userId:1,requestHash:i.toString(16).padStart(32,'0'),messageHash:(i+100).toString(16).padStart(32,'0')}));assert.equal(response.status,200);const data=await response.json();if(i<60)assert.equal(data.allowed,true);}
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM enforcement_cases').get().n,1);const saved=values.get('fair-use-window');assert.equal(saved.pending,undefined);assert.ok(!JSON.stringify(saved).includes('prompt'));assert.ok(!f.sqlite.prepare('SELECT evidence FROM enforcement_cases').get().evidence.includes('requestHash'));
  saved.pending={userId:1,signalId:'pending-exact-once',rule:'request_burst',evidence:{requests:700},now:Date.now()};values.set('fair-use-window',saved);
  for(let i=0;i<2;i++)await object.fetch(request('/fair-use',{userId:1,requestHash:'f'.repeat(32),messageHash:null}));assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM enforcement_cases WHERE signal_id='pending-exact-once'").get().n,1);
 }finally{f.sqlite.close();}
});
test('gateway checks headers without reading conversation text, and only enforcement notices can change account state',async()=>{
 const f=fixture();try{let input;const env={...f.env,ACCOUNT_EVENTS:{idFromName:value=>value,get:()=>({fetch:async(_url,init)=>{input=JSON.parse(init.body);return Response.json({allowed:true});}})}};
  const body=JSON.stringify({model:'example',messages:[{role:'user',content:'政治观点、合法商用、求助、引用材料和粗俗用语都不是自动封号信号'}]});const req=new Request('https://test/tochat/v1/chat/completions',{method:'POST',headers:{'x-tochat-request-id':'request-fixture','x-tochat-message-id':'message-fixture'},body});
  assert.equal(await gateOfficialRequest(req,env,{waitUntil(){}},{id:1}),null);assert.equal(await req.text(),body);assert.equal(input.userId,1);assert.ok(!JSON.stringify(input).includes('政治'));assert.equal(input.requestHash.length,32);
 }finally{f.sqlite.close();}
});
test('published policy matches the actual thresholds and migration is compatible with runtime setup',async()=>{
 const f=fixture();try{f.sqlite.exec(readFileSync(new URL('../migrations/0012_enforcement.sql',import.meta.url),'utf8'));await ensureEnforcement(f.db);
 const source=readFileSync(new URL('../../../Agent工具AI模型使用准则.md',import.meta.url),'utf8');assert.ok(source.includes(POLICY_VERSION));assert.ok(source.includes('| 正常账号 | 600 | 60 |'));assert.ok(source.includes('| 限流或观察状态 | 120 | 6 |'));assert.ok(source.includes('不会自动永久封号'));
 }finally{f.sqlite.close();}
});
