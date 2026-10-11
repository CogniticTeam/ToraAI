import {publishAccountEvent} from './account-events.js';

export const POLICY_VERSION='2026-10-11.1';
export const POLICY_URL='https://ohfun.online/policies/agent-model-usage/';
export const DAY=86400000;
export const FAIR_USE_LIMITS=Object.freeze({requests:600,newTurns:60,limitedRequests:120,limitedTurns:6,incidentCooldown:10*60000});
const schema=[
 "CREATE TABLE IF NOT EXISTS enforcement_cases(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,signal_id TEXT NOT NULL UNIQUE,rule TEXT NOT NULL,level INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,evidence TEXT NOT NULL,policy_version TEXT NOT NULL,limited_until INTEGER,ban_until INTEGER,observation_until INTEGER,permanent INTEGER NOT NULL DEFAULT 0,acknowledged_at INTEGER,review_note TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,reviewed_at INTEGER)",
 'CREATE INDEX IF NOT EXISTS idx_enforcement_cases_user ON enforcement_cases(user_id,created_at)',
 "CREATE TABLE IF NOT EXISTS enforcement_appeals(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,case_id TEXT NOT NULL,statement TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',response TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,reviewed_at INTEGER)",
 "CREATE UNIQUE INDEX IF NOT EXISTS idx_enforcement_pending_appeal ON enforcement_appeals(user_id,case_id) WHERE status='pending'",
 'CREATE TABLE IF NOT EXISTS enforcement_audit(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,case_id TEXT,action TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS manual_ban_versions(user_id INTEGER PRIMARY KEY,version TEXT NOT NULL)',
];
const initialized=new WeakSet();
export async function ensureEnforcement(db){if(initialized.has(db))return;for(const sql of schema)await db.prepare(sql).bind().run();initialized.add(db);}
const active="status IN ('automatic','confirmed')";
export async function readEnforcement(db,userId,now=Date.now()){
 await ensureEnforcement(db);
 const row=await db.prepare(`SELECT MAX(limited_until) limited_until,MAX(ban_until) ban_until,MAX(observation_until) observation_until,MAX(permanent) permanent FROM enforcement_cases WHERE user_id=? AND ${active}`).bind(userId).first();
 const banned=!!row?.permanent||(row?.ban_until||0)>now,limited=(row?.limited_until||0)>now,observation=(row?.observation_until||0)>now;
 const last=await db.prepare(`SELECT id,level,reason,policy_version,acknowledged_at,created_at FROM enforcement_cases WHERE user_id=? AND ${active} ORDER BY created_at DESC,id DESC LIMIT 1`).bind(userId).first();
 return {banned,limited:limited||observation,observation,permanent:!!row?.permanent,banUntil:banned&&!row.permanent?new Date(row.ban_until).toISOString():null,limitedUntil:limited?new Date(row.limited_until).toISOString():null,observationUntil:observation?new Date(row.observation_until).toISOString():null,case:last||null,policyVersion:POLICY_VERSION,policyURL:POLICY_URL};
}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'}});
const detail=(message,status=400)=>Object.assign(Error(message),{status});
async function notify(env,userId){if(!env.ACCOUNT_EVENTS)return;try{await publishAccountEvent(env,userId,{type:'account-changed'});}catch{/* Polling provides delivery recovery. */}}
export async function recordRateIncident(db,{userId,signalId,rule,evidence,now=Date.now()}){
 await ensureEnforcement(db);
 const existing=await db.prepare('SELECT * FROM enforcement_cases WHERE signal_id=?').bind(signalId).first();if(existing)return existing;
 const state=await readEnforcement(db,userId,now);
 const history=await db.prepare(`SELECT SUM(CASE WHEN level=1 AND created_at>? AND created_at>COALESCE((SELECT MAX(created_at) FROM enforcement_cases WHERE user_id=? AND level>=2 AND ${active}),0) THEN 1 ELSE 0 END) minors,SUM(CASE WHEN level=2 AND created_at>? THEN 1 ELSE 0 END) moderates FROM enforcement_cases WHERE user_id=? AND ${active}`).bind(now-90*DAY,userId,now-180*DAY,userId).first();
 const level=state.observation?3:(history?.minors||0)+1>=3?2:1;
 const days=level===1?0:level===3?7:[7,15,30][Math.min(2,history?.moderates||0)];
 const id=crypto.randomUUID(),limitedUntil=level===1?now+DAY:null,banUntil=days?now+days*DAY:null,observationUntil=banUntil?banUntil+30*DAY:null;
 const reason=`持续超出公平使用阈值（${rule==='request_burst'?'模型请求频率':'新消息频率'}）。${level===1?'已进入 24 小时限流。':`暂时限制 ${days} 天，等待管理员复核。`}`;
 await db.batch([
  db.prepare("INSERT INTO enforcement_cases(id,user_id,signal_id,rule,level,status,reason,evidence,policy_version,limited_until,ban_until,observation_until,created_at) VALUES(?,?,?,?,?,'automatic',?,?,?,?,?,?,?) ON CONFLICT(signal_id) DO NOTHING").bind(id,userId,signalId,rule,level,reason,JSON.stringify(evidence),POLICY_VERSION,limitedUntil,banUntil,observationUntil,now),
  db.prepare('INSERT INTO enforcement_audit(id,user_id,case_id,action,detail,created_at) SELECT ?,?,?,?, ?,? WHERE EXISTS(SELECT 1 FROM enforcement_cases WHERE id=?)').bind(crypto.randomUUID(),userId,id,'automatic',JSON.stringify({level,days,rule}),now,id),
 ]);
 return db.prepare('SELECT * FROM enforcement_cases WHERE signal_id=?').bind(signalId).first();
}

/** Pure, bounded metadata counter. Retries/tool steps never become new user turns. */
export function measureFairUse(previous,{now,requestHash,messageHash},limited=false){
 const state={attempts:(previous?.attempts||[]).filter(time=>time>now-60000),requests:Object.fromEntries(Object.entries(previous?.requests||{}).filter(([,time])=>time>now-60000)),turns:Object.fromEntries(Object.entries(previous?.turns||{}).filter(([,time])=>time>now-10*60000)),lastIncident:previous?.lastIncident||0};
 state.attempts.push(now);state.attempts=state.attempts.slice(-2000);state.requests[requestHash]=now;
 if(messageHash&&!Object.hasOwn(state.turns,messageHash))state.turns[messageHash]=now;
 state.requests=Object.fromEntries(Object.entries(state.requests).slice(-1000));state.turns=Object.fromEntries(Object.entries(state.turns).slice(-900));
 const turns=Object.values(state.turns).filter(time=>time>now-60000).length,requests=state.attempts.length,uniqueRequests=Object.keys(state.requests).length;
 const requestLimit=limited?FAIR_USE_LIMITS.limitedRequests:FAIR_USE_LIMITS.requests,turnLimit=limited?FAIR_USE_LIMITS.limitedTurns:FAIR_USE_LIMITS.newTurns;
 const rule=requests>requestLimit?'request_burst':turns>turnLimit?'new_turn_burst':null;
 // A few retries/continuations receive HTTP throttling, not an account violation.
 const incident=!!rule&&uniqueRequests>=20&&(state.lastIncident===0||now-state.lastIncident>=FAIR_USE_LIMITS.incidentCooldown);
 if(incident)state.lastIncident=now;
 return {state,allowed:!rule,incident,rule,evidence:{requests,newTurns:turns,uniqueRequests,requestLimit,turnLimit,windowSeconds:60},retryAfter:60};
}
export async function gateOfficialRequest(request,env,ctx,user){
 if(!user||user.banned)return null;
 if(env.ABUSE_ENFORCEMENT_ENABLED==='0')return null;
 if(!env.ACCOUNT_EVENTS)return json({detail:'公平使用校验暂不可用'},503);
 const rawRequest=request.headers.get('x-tochat-request-id'),rawMessage=request.headers.get('x-tochat-message-id');
 const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,32);
 const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(value);
 const input={userId:user.id,requestHash:await hash(valid(rawRequest)?rawRequest:crypto.randomUUID()),messageHash:valid(rawMessage)?await hash(rawMessage):null};
 let decision;try{const hub=env.ACCOUNT_EVENTS.get(env.ACCOUNT_EVENTS.idFromName('fair-use:'+user.id)),response=await hub.fetch('https://internal/fair-use',{method:'POST',body:JSON.stringify(input)});if(!response.ok)throw Error();decision=await response.json();}catch{return json({detail:'公平使用校验暂不可用，请稍后重试'},503);}
 if(decision.changed)ctx.waitUntil(notify(env,user.id));
 if(decision.allowed)return null;
 const response=json({code:decision.banned?'ACCOUNT_BANNED':'FAIR_USE_LIMITED',detail:decision.reason||'请求频率超过公平使用阈值，请稍后重试',retryAfter:decision.retryAfter||60,enforcement:decision.enforcement,policyURL:POLICY_URL},decision.banned?403:429);response.headers.set('retry-after',String(decision.retryAfter||60));return response;
}
export async function handleUserEnforcement(request,env,user){
 if(!user)return json({detail:'请先登录'},401);
 const path=new URL(request.url).pathname;
 try{
  await ensureEnforcement(env.DB);
  if(request.method==='GET'&&path==='/account/enforcement'){
   const cases=await env.DB.prepare('SELECT id,level,status,reason,policy_version,limited_until,ban_until,permanent,review_note,created_at FROM enforcement_cases WHERE user_id=? ORDER BY created_at DESC LIMIT 30').bind(user.id).all();
   const appeals=await env.DB.prepare('SELECT id,case_id,statement,status,response,created_at,reviewed_at FROM enforcement_appeals WHERE user_id=? ORDER BY created_at DESC LIMIT 30').bind(user.id).all();
   return json({state:await readEnforcement(env.DB,user.id),cases:cases.results||[],appeals:appeals.results||[]});
  }
  const raw=await request.text();if(raw.length>10000)throw detail('提交内容过大',413);const body=JSON.parse(raw);
  if(path==='/account/enforcement/ack'&&request.method==='POST'){
   const result=await env.DB.prepare('UPDATE enforcement_cases SET acknowledged_at=? WHERE id=? AND user_id=?').bind(Date.now(),body.caseId,user.id).run();if(!result.meta.changes)throw detail('记录不存在',404);return json({ok:true});
  }
  if(path==='/account/enforcement/appeals'&&request.method==='POST'){
   const statement=String(body.statement||'').trim();if(statement.length<10||statement.length>3000)throw detail('请填写 10 至 3000 字的申诉说明');
   if(/(?:sk-[A-Za-z0-9_-]{16,}|ark-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/.test(statement))throw detail('请移除 API Key 或登录凭证后再提交');
   let caseId=body.caseId;
   if(caseId){if(!await env.DB.prepare('SELECT id FROM enforcement_cases WHERE id=? AND user_id=?').bind(caseId,user.id).first())throw detail('记录不存在',404);}
   else{const manual=await env.DB.prepare('SELECT banned FROM users WHERE id=?').bind(user.id).first();if(!manual?.banned)throw detail('请先选择处罚记录');const version=await env.DB.prepare('SELECT version FROM manual_ban_versions WHERE user_id=?').bind(user.id).first();caseId='manual:'+user.id+':'+(version?.version||'legacy');}
   const existing=await env.DB.prepare("SELECT id FROM enforcement_appeals WHERE user_id=? AND case_id=? AND status='pending'").bind(user.id,caseId).first();if(existing)return json({id:existing.id,pending:true});
   const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO enforcement_appeals(id,user_id,case_id,statement,created_at) VALUES(?,?,?,?,?)').bind(id,user.id,caseId,statement,Date.now()).run();return json({id,pending:true});
  }
  return json({detail:'接口不存在'},404);
 }catch(error){return json({detail:error instanceof SyntaxError?'提交格式无效':error.message},error.status||400);}
}
export async function handleAdminEnforcement(request,env){
 try{
  await ensureEnforcement(env.DB);const path=new URL(request.url).pathname;
  if(path==='/admin/enforcement'&&request.method==='GET'){
   const offset=Math.max(0,Math.min(100000,Number.parseInt(new URL(request.url).searchParams.get('offset')||'0',10)||0));
   const cases=await env.DB.prepare('SELECT c.*,u.email,u.username FROM enforcement_cases c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC,c.id DESC LIMIT 100 OFFSET ?').bind(offset).all();
   const appeals=await env.DB.prepare('SELECT a.*,u.email,u.username FROM enforcement_appeals a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100').bind().all();
   return json({cases:cases.results||[],appeals:appeals.results||[],nextOffset:cases.results?.length===100?offset+100:null,policyVersion:POLICY_VERSION,limits:FAIR_USE_LIMITS});
  }
  const match=path.match(/^\/admin\/enforcement\/(cases|appeals)\/([a-zA-Z0-9-]{1,100})\/review$/);if(!match||request.method!=='POST')return json({detail:'接口不存在'},404);
  const raw=await request.text();if(raw.length>10000)throw detail('提交内容过大',413);const body=JSON.parse(raw),note=String(body.note||'').trim();if(note.length<10||note.length>3000)throw detail('请填写 10 至 3000 字的复核依据');
  const now=Date.now();let userId,caseId;
  if(match[1]==='cases'){
   const item=await env.DB.prepare('SELECT * FROM enforcement_cases WHERE id=?').bind(match[2]).first();if(!item)throw detail('案件不存在',404);userId=item.user_id;caseId=item.id;
   if(!['revoke','confirm','permanent'].includes(body.action))throw detail('复核操作无效');
   if(item.permanent&&body.action==='confirm')throw detail('维持永久封禁需选择永久封禁并重新核对账号');
   if(body.action==='permanent'&&(item.level!==3||body.confirmUserId!==item.user_id))throw detail('永久封禁必须核对三级案件和账户 ID');
   await env.DB.batch([
    env.DB.prepare("UPDATE enforcement_cases SET status=?,permanent=CASE WHEN ?='permanent' THEN 1 ELSE 0 END,review_note=?,reviewed_at=? WHERE id=?").bind(body.action==='revoke'?'revoked':'confirmed',body.action,note,now,item.id),
    env.DB.prepare('INSERT INTO enforcement_audit(id,user_id,case_id,action,detail,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),userId,caseId,body.action,note,now),
   ]);
  }else{
   const appeal=await env.DB.prepare('SELECT * FROM enforcement_appeals WHERE id=?').bind(match[2]).first();if(!appeal)throw detail('申诉不存在',404);userId=appeal.user_id;caseId=appeal.case_id;
   if(!['accepted','rejected'].includes(body.action))throw detail('申诉处理结果无效');
   const manualVersion=caseId.startsWith('manual:')?caseId.split(':')[2]:null;
   if(manualVersion){const current=await env.DB.prepare('SELECT version FROM manual_ban_versions WHERE user_id=?').bind(userId).first();if((current?.version||'legacy')!==manualVersion)throw detail('人工处罚已变更，请重新核对后处理',409);}
   const statements=[env.DB.prepare("UPDATE enforcement_appeals SET status=?,response=?,reviewed_at=? WHERE id=? AND status='pending' AND (? IS NULL OR COALESCE((SELECT version FROM manual_ban_versions WHERE user_id=?),'legacy')=?)").bind(body.action,note,now,appeal.id,manualVersion,userId,manualVersion)];
   if(appeal.status!=='pending')throw detail('申诉已处理',409);
   if(body.action==='accepted')statements.push(manualVersion?env.DB.prepare("UPDATE users SET banned=0,ban_reason='' WHERE id=? AND COALESCE((SELECT version FROM manual_ban_versions WHERE user_id=?),'legacy')=? AND EXISTS(SELECT 1 FROM enforcement_appeals WHERE id=? AND status='accepted' AND reviewed_at=?)").bind(userId,userId,manualVersion,appeal.id,now):env.DB.prepare("UPDATE enforcement_cases SET status='revoked',review_note=?,reviewed_at=? WHERE id=? AND user_id=? AND EXISTS(SELECT 1 FROM enforcement_appeals WHERE id=? AND status='accepted' AND reviewed_at=?)").bind(note,now,caseId,userId,appeal.id,now));
   statements.push(env.DB.prepare('INSERT INTO enforcement_audit(id,user_id,case_id,action,detail,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM enforcement_appeals WHERE id=? AND reviewed_at=?)').bind(crypto.randomUUID(),userId,caseId,'appeal:'+body.action,note,now,appeal.id,now));const results=await env.DB.batch(statements);if(results[0]?.meta?.changes!==1)throw detail('处罚或申诉状态已变更，请刷新重试',409);
  }
  await notify(env,userId);return json({ok:true,state:await readEnforcement(env.DB,userId)});
 }catch(error){return json({detail:error instanceof SyntaxError?'提交格式无效':error.message},error.status||400);}
}
