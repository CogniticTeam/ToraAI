import {PLANS,CREDIT_SCALE,WINDOWS} from './subscription-plans.js';
import {readAgentQuota,publicQuota} from './agent-credits.js';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*'}});
const failure=error=>json({code:/BUSY/.test(error.message)?'busy':/CARD/.test(error.message)?'card_unavailable':/SUBSCRIPTION/.test(error.message)?'subscription_required':'invalid',detail:/BUSY/.test(error.message)?'请先结束正在运行的官方模型任务，再重置额度':/CARD/.test(error.message)?'重置卡已使用、已过期或不属于此账号':/DOWNGRADE/.test(error.message)?'不能覆盖已有的更高档订阅':/SUBSCRIPTION/.test(error.message)?'请先开通订阅':error.message},/BUSY|CARD|SUBSCRIPTION/.test(error.message)?409:400);
function targets(body){if(body.scope==='all')return{where:'1=1',args:[],scope:'all'};const ids=[...new Set(body.userIds||[])];if(!ids.length||ids.length>500||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('请选择有效用户，单次最多500人');return{where:'id IN ('+ids.map(()=>'?').join(',')+')',args:ids,scope:'selected'};}
export async function handleAdminQuota(request,env){
 const kind=new URL(request.url).pathname.replace(/\/+$/,'').split('/').pop();
 if(!['reset','cards','subscription','cancel-subscription'].includes(kind))return json({detail:'Not Found'},404);
 if(request.method!=='POST')return json({detail:'Not Found'},404);let body;try{body=await request.json();}catch{return json({detail:'请求格式无效'},400);}
 try{
 const target=targets(body);
 const op=body.operationId||crypto.randomUUID();if(!/^[\w-]{8,100}$/.test(op))throw Error('操作标识无效');
 const now=Date.now(),detail=JSON.stringify({scope:target.scope,userIds:target.args,planId:body.planId,days:body.days,count:body.count});
 const existing=await env.DB.prepare('SELECT * FROM quota_admin_operations WHERE id=?').bind(op).first();if(existing){if(existing.kind!==kind||existing.detail!==detail)throw Error('操作标识已用于其它请求');return json({ok:true,replayed:true,operationId:op});}
 const matched=await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE '+target.where).bind(...target.args).first();if(!matched.n)throw Error('没有匹配用户');if(target.scope!=='all'&&matched.n!==target.args.length)throw Error('包含不存在的用户');
 const statements=[env.DB.prepare('INSERT INTO quota_admin_operations(id,kind,detail,created_at) VALUES(?,?,?,?)').bind(op,kind,detail,now)];
 if(kind==='reset'){
  statements.push(env.DB.prepare("INSERT INTO quota_reset_events(id,user_id,operation_id,created_at) SELECT ?||'_'||id,id,?,? FROM users WHERE "+target.where+" AND NOT EXISTS(SELECT 1 FROM usage_log WHERE user_id=users.id AND status='pending' AND created_at>?)").bind(op,op,now,...target.args,now-300000));
 }else if(kind==='cards'){
  const count=Number(body.count??1);if(!Number.isSafeInteger(count)||count<1||count>100)throw Error('每人发放数量应为1至100张');
  statements.push(env.DB.prepare('WITH RECURSIVE cards(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cards WHERE n<?) INSERT INTO quota_reset_cards(id,user_id,operation_id,issued_at,expires_at) SELECT lower(hex(randomblob(16))),users.id,?,?,? FROM users CROSS JOIN cards WHERE '+target.where).bind(count,op,now,now+WINDOWS.month,...target.args));
 }else if(kind==='cancel-subscription'){
  statements.push(env.DB.prepare('UPDATE user_subscription SET expires_at=?,updated_at=? WHERE expires_at>? AND user_id IN (SELECT id FROM users WHERE '+target.where+')').bind(now,now,now,...target.args));
 }else{
  const plan=PLANS.find(item=>item.id===body.planId),days=Number(body.days??30);if(!plan||!Number.isSafeInteger(days)||days<1||days>3650)throw Error('请选择有效套餐和1至3650天有效期');
  statements.push(env.DB.prepare('INSERT INTO user_subscription(user_id,plan_id,expires_at,five_hour_limit,week_limit,month_limit,updated_at) SELECT id,?,?,?,?,?,? FROM users WHERE '+target.where+' ON CONFLICT(user_id) DO UPDATE SET plan_id=excluded.plan_id,expires_at=CASE WHEN user_subscription.plan_id=excluded.plan_id THEN MAX(user_subscription.expires_at,?)+? ELSE excluded.expires_at END,five_hour_limit=excluded.five_hour_limit,week_limit=excluded.week_limit,month_limit=excluded.month_limit,updated_at=excluded.updated_at').bind(plan.id,now+days*86400000,(plan.limits.fiveHour||0)*CREDIT_SCALE,(plan.limits.week||0)*CREDIT_SCALE,(plan.limits.month||0)*CREDIT_SCALE,now,...target.args,now,days*86400000));
 }
 statements.push(env.DB.prepare('INSERT INTO admin_audit(action,user_id,detail,created_at) VALUES(?,NULL,?,?)').bind('quota-'+kind,JSON.stringify({operationId:op,...JSON.parse(detail)}),new Date(now).toISOString()));
 let results;try{results=await env.DB.batch(statements);}catch(error){if(/UNIQUE/.test(error.message)){const prior=await env.DB.prepare('SELECT kind,detail FROM quota_admin_operations WHERE id=?').bind(op).first();if(prior?.kind===kind&&prior.detail===detail)return json({ok:true,replayed:true,operationId:op});}throw error;}
 const affected=kind==='reset'?(await env.DB.prepare('SELECT COUNT(*) AS n FROM quota_reset_events WHERE operation_id=?').bind(op).first()).n:kind==='cancel-subscription'?results[1].meta.changes:matched.n;
 return json({ok:true,operationId:op,affectedUsers:affected,skippedBusyUsers:kind==='reset'?matched.n-affected:0,issuedCards:kind==='cards'?matched.n*Number(body.count??1):undefined});
 }catch(error){return failure(error);}
}
export async function handleUserQuota(request,env,user){
 if(!user)return json({detail:'请先登录'},401);if(user.banned)return json({detail:'账户已被封禁'},403);const path=new URL(request.url).pathname,now=Date.now();
 if(path==='/quota/overview'&&request.method==='GET'){
  const cards=(await env.DB.prepare('SELECT id,issued_at,expires_at,used_at FROM quota_reset_cards WHERE user_id=? ORDER BY CASE WHEN used_at IS NULL AND expires_at>? THEN 0 ELSE 1 END,expires_at ASC LIMIT 200').bind(user.id,now).all()).results;
  const history=(await env.DB.prepare('SELECT id,card_id,created_at FROM quota_reset_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(user.id).all()).results;
  const available=(await env.DB.prepare('SELECT COUNT(*) AS n FROM quota_reset_cards WHERE user_id=? AND used_at IS NULL AND expires_at>?').bind(user.id,now).first()).n;
  return json({availableCards:available,...publicQuota(await readAgentQuota(env.DB,user.id,now)),cards:cards.map(card=>({...card,status:card.used_at?'used':card.expires_at<=now?'expired':'available'})),history,serverTime:now});
 }
 if(path==='/quota/cards/use'&&request.method==='POST'){
  try{const body=await request.json();if(typeof body.cardId!=='string'||!/^[a-f0-9]{32}$/.test(body.cardId))throw Error('重置卡无效');
   await env.DB.prepare('INSERT INTO quota_reset_events(id,user_id,operation_id,card_id,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),user.id,'card-use',body.cardId,now).run();
   return json({ok:true,...publicQuota(await readAgentQuota(env.DB,user.id,now))});
  }catch(error){return failure(error);}
 }
 return json({detail:'Not Found'},404);
}
