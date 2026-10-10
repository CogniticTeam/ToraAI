const DEFAULT_TURNSTILE_HOSTNAMES = '127.0.0.1,localhost,ohfun.online';

/** 校验 Turnstile token；返回 false 一律 403。未配置 secret 时拒绝；只有显式本地测试开关可跳过。 */
export async function verifyTurnstile(env, request, token, expectedAction) {
  if (!env.TURNSTILE_SECRET) return env.TURNSTILE_DEV_BYPASS==='1';
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  const hostnames = new Set(
    (env.TURNSTILE_HOSTNAMES ?? DEFAULT_TURNSTILE_HOSTNAMES)
      .split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (hostnames.size === 0) return false;
  let result;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get('cf-connecting-ip') ?? '',
      }),
    });
    if (!r.ok) return false;
    result = await r.json();
  } catch {
    // siteverify 网络故障按拒绝处理（fail-closed）
    return false;
  }
  return result.success === true
    && result.action === expectedAction
    && hostnames.has(result.hostname);
}


export const HUMAN_VERIFICATION_TTL=30*60*1000;
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','access-control-allow-origin':'*','cache-control':'no-store'}});
export const verificationRequired=()=>({code:'human_verification_required',detail:'请先完成人机验证，再使用免费体验'});
async function tokenHash(token){
 if(!token)return null;
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
 return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
}
export async function readHumanVerification(env,request,userId,now=Date.now()){
 if(!env.TURNSTILE_SECRET&&env.TURNSTILE_DEV_BYPASS==='1')return{required:false,verified:true,expiresAt:null,sessionHash:null};
 const auth=request.headers.get('authorization')||'',token=auth.startsWith('Bearer ')?auth.slice(7).trim():'';
 const sessionHash=await tokenHash(token);
 if(!sessionHash)return{required:true,verified:false,expiresAt:null,sessionHash:null};
 const row=await env.DB.prepare('SELECT expires_at FROM human_verification_sessions WHERE token_hash=? AND user_id=? AND expires_at>?').bind(sessionHash,userId,now).first();
 return{required:true,verified:!!row,expiresAt:row?new Date(row.expires_at).toISOString():null,sessionHash};
}
export const publicHumanVerification=({required,verified,expiresAt})=>({required,verified,expiresAt});
export async function verificationSessionStatement(db,token,userId,now=Date.now()){
 return db.prepare('INSERT INTO human_verification_sessions(token_hash,user_id,verified_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET user_id=excluded.user_id,verified_at=excluded.verified_at,expires_at=excluded.expires_at').bind(await tokenHash(token),userId,now,now+HUMAN_VERIFICATION_TTL);
}
export async function trialTurnVerified(db,userId,messageId,sessionHash){
 if(!sessionHash)return false;
 return !!await db.prepare('SELECT 1 AS verified FROM human_verified_trial_turns WHERE user_id=? AND message_id=? AND token_hash=?').bind(userId,messageId,sessionHash).first();
}
export function verifiedTrialStatement(db,userId,messageId,sessionHash,now=Date.now()){
 return db.prepare('INSERT OR IGNORE INTO human_verified_trial_turns(user_id,message_id,token_hash,verified_at) VALUES(?,?,?,?)').bind(userId,messageId,sessionHash,now);
}
export async function handleHumanVerification(request,env,user){
 if(!user)return json({detail:'请先登录'},401);
 if(user.banned)return json({detail:'账户已被封禁'},403);
 if(request.method==='GET')return json(publicHumanVerification(await readHumanVerification(env,request,user.id)));
 if(request.method!=='POST')return json({detail:'Not Found'},404);
 let body;try{const raw=await request.text();if(new TextEncoder().encode(raw).length>4096)return json({detail:'验证请求过大'},413);body=JSON.parse(raw);}catch{return json({detail:'验证请求无效'},400);}
 if(!env.TURNSTILE_SECRET&&env.TURNSTILE_DEV_BYPASS!=='1')return json({detail:'人机验证服务暂不可用'},503);
 if(!await verifyTurnstile(env,request,body?.['cf-turnstile-response'],'free_trial'))return json({code:'human_verification_failed',detail:'人机验证失败，请重试'},403);
 const state=await readHumanVerification(env,request,user.id);
 if(state.required){
  if(!state.sessionHash)return json({detail:'请先登录'},401);
  const token=request.headers.get('authorization').slice(7).trim(),now=Date.now();
  await env.DB.batch([env.DB.prepare('DELETE FROM human_verification_sessions WHERE expires_at<=?').bind(now),await verificationSessionStatement(env.DB,token,user.id,now)]);
 }
 return json({ok:true,...publicHumanVerification(await readHumanVerification(env,request,user.id))});
}
