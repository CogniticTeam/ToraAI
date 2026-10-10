// Standard Ark prices verified 2026-10-11: text/image/video input ¥0.8/M,
// audio input ¥12/M, output (including reasoning) ¥2.7/M. Cache discounts are ignored.
// Daily reservation is separate from subscription Credits. Never refund unknown requests.
export const DOUBAO_WORK_TURNS=10, DOUBAO_WORK_BUDGET_NANO=200000000, DOUBAO_WORK_ROUNDS=8;
export const doubaoWorkCost=(inputBound,output,hasAudio=false)=>Math.ceil(inputBound*(hasAudio?12000:800)+output*2700);
export async function readDoubaoWorkQuota(db,userId,{day,dailyReset}){
 const row=await db.prepare('SELECT (SELECT COUNT(*) FROM doubao_work_turns WHERE user_id=? AND day=?) AS used,(SELECT COALESCE(SUM(cost_nano),0) FROM doubao_work_requests WHERE user_id=? AND day=?) AS reserved').bind(userId,day,userId,day).first();
 const used=Number(row?.used)||0,reserved=Number(row?.reserved)||0;
 return {total:DOUBAO_WORK_TURNS,used,remaining:Math.max(0,DOUBAO_WORK_TURNS-used),resetAt:dailyReset,canUse:used<DOUBAO_WORK_TURNS&&DOUBAO_WORK_BUDGET_NANO-reserved>=doubaoWorkCost(1024,4096)};
}
export function reserveDoubaoWorkStatements(db,{userId,messageId,requestId,day,fingerprint,now,cost}){
 return [
  db.prepare('INSERT INTO doubao_work_turns(user_id,message_id,day,fingerprint,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,message_id) DO NOTHING').bind(userId,messageId,day,fingerprint,now),
  db.prepare('INSERT INTO doubao_work_requests(user_id,request_id,message_id,day,cost_nano,created_at) VALUES(?,?,?,?,?,?)').bind(userId,requestId,messageId,day,cost,now),
 ];
}
export function settleDoubaoWorkStatements(db,{userId,messageId,requestId,failed,unknown}){
 return [
  db.prepare("UPDATE doubao_work_requests SET cost_nano=CASE WHEN ? THEN 0 ELSE cost_nano END,status=? WHERE user_id=? AND request_id=? AND status='pending'").bind(failed?1:0,failed?'failed':unknown?'unknown':'settled',userId,requestId),
  ...(failed?[db.prepare("DELETE FROM doubao_work_turns WHERE user_id=? AND message_id=? AND EXISTS(SELECT 1 FROM tochat_turns WHERE user_id=? AND message_id=? AND current_request=? AND rounds=1) AND EXISTS(SELECT 1 FROM doubao_work_requests WHERE user_id=? AND request_id=? AND status='failed')").bind(userId,messageId,userId,messageId,requestId,userId,requestId)]:[]),
 ];
}
export const doubaoWorkFailure=code=>({code:'doubao_work_limit',detail:code==='DOUBAO_WORK_ROUND_LIMIT'?'豆包单条工作消息的工具轮次已达上限，请发送新消息或切换其他模型':'豆包今日工作免费额度已用完或不足以处理当前上下文，请在 GMT+8 零点后重试，或切换其他模型'});
