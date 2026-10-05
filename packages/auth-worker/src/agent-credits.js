import {CREDIT_SCALE,WINDOWS,PLANS,usageCost,usageTokens} from './subscription-plans.js';
export async function readAgentQuota(db,userId,now=Date.now()){
 const subscription=await db.prepare('SELECT * FROM user_subscription WHERE user_id=? AND expires_at>?').bind(userId,now).first();
 const windows=[];
 if(subscription)for(const [key,column] of [['fiveHour','five_hour_limit'],['week','week_limit'],['month','month_limit']]){
  const limit=subscription[column];if(!limit)continue;const span=WINDOWS[key];
  const row=await db.prepare('SELECT COALESCE(SUM(credit_micro),0) AS used,COALESCE(SUM(credit_micro+held_micro),0) AS committed,MIN(CASE WHEN credit_micro+held_micro>0 THEN created_at END) AS oldest FROM usage_log WHERE user_id=? AND created_at>?').bind(userId,now-span).first();
  windows.push({key,remainingPercent:Math.max(0,Math.min(100,(limit-row.used)/limit*100)),resetAt:row.oldest?new Date(row.oldest+span).toISOString():null,availableMicro:Math.max(0,limit-row.committed),limitMicro:limit});
 }
 const availableMicro=windows.length?Math.min(...windows.map(window=>window.availableMicro)):0;
 return {subscription:subscription?{planId:subscription.plan_id,name:PLANS.find(plan=>plan.id===subscription.plan_id)?.name,expiresAt:new Date(subscription.expires_at).toISOString()}:null,remainingPercent:windows.length?Math.min(...windows.map(window=>window.remainingPercent)):0,canUseAgent:availableMicro>0,windows,availableMicro};
}
export const publicQuota=quota=>({subscription:quota.subscription,remainingPercent:quota.remainingPercent,canUseAgent:quota.canUseAgent,windows:quota.windows.map(({key,remainingPercent,resetAt})=>({key,remainingPercent,resetAt}))});
export function reserveCreditStatement(db,{userId,requestId,model,feature,reserved,now}){return db.prepare('INSERT INTO usage_log(user_id,request_id,model,feature,held_micro,created_at) VALUES(?,?,?,?,?,?)').bind(userId,requestId,model,feature,reserved,now);}
export async function progressCredit(db,userId,requestId,estimated){await db.prepare("UPDATE usage_log SET credit_micro=MIN(credit_micro+held_micro,?),held_micro=MAX(0,credit_micro+held_micro-?) WHERE user_id=? AND request_id=? AND status='pending'").bind(estimated,estimated,userId,requestId).run();}
export function settleCreditStatement(db,{userId,requestId,model,usage,failed=false,unknown=false,env={}}){
 const tokens=usageTokens(usage);const amount=tokens?usageCost(model,tokens,env):null;
 // Unknown/cancelled usage retains the reservation rather than permitting free retries.
 return db.prepare("UPDATE usage_log SET credit_micro=CASE WHEN ? THEN 0 WHEN ? IS NOT NULL THEN MIN(credit_micro+held_micro,?) ELSE credit_micro+held_micro END,held_micro=0,input_tokens=?,cached_tokens=?,output_tokens=?,status=?,finished_at=? WHERE user_id=? AND request_id=? AND status='pending'").bind(failed?1:0,amount,amount,tokens?.input??0,tokens?.cached??0,tokens?.output??0,failed?'failed':unknown||!tokens?'unknown':'settled',Date.now(),userId,requestId);
}
export async function settleCredit(db,params){return settleCreditStatement(db,params).run();}

