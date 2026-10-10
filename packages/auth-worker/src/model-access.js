import {MODEL_MINIMUM_PLAN,hasModelSubscription} from '../../core/src/model-access.js';
export async function readDeepSeekTrial(db,userId){
 const row=await db.prepare('SELECT limit_turns,(SELECT COUNT(*) FROM model_trial_turns WHERE user_id=?) AS used FROM model_trial_accounts WHERE user_id=?').bind(userId,userId).first();
 return {model:'deepseek-flash',total:row?.limit_turns||0,used:row?.used||0,remaining:Math.max(0,(row?.limit_turns||0)-(row?.used||0))};
}
export const modelAccessAllowed=(model,quota)=>hasModelSubscription(model,quota?.subscription)||(model==='deepseek-flash'&&(quota?.trial?.remaining||0)>0);
export function modelAccessFailure(model){
 if(model==='deepseek-flash')return{code:'trial_exhausted',detail:'DeepSeek 免费体验次数已用完，请开通 Plus 或以上订阅',requiredPlan:'plus'};
 const requiredPlan=MODEL_MINIMUM_PLAN[model],name={plus:'Plus',pro:'Pro',max5:'Max 5x'}[requiredPlan];
 return{code:'subscription_required',detail:`此模型需要 ${name} 或以上订阅`,requiredPlan};
}
export function reserveTrialStatement(db,{userId,messageId,fingerprint,now}){
 return db.prepare('INSERT INTO model_trial_turns(user_id,message_id,fingerprint,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,message_id) DO NOTHING').bind(userId,messageId,fingerprint,now);
}
