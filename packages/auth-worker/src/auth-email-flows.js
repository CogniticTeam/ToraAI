import {verifyTurnstile} from './human-verification.js';
import {authJSON,authError,authLimit,consumeEmailCode,digest,readAuthBody,randomToken} from './auth-security.js';

const validEmail=email=>typeof email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&email.length<=254;
const publicUser=(user,token)=>({token,email:user.email,username:user.username,createdAt:user.created_at,avatar:user.avatar??null});

export async function handleAuthEmail(request,env,path,helpers,ctx){
 if(request.method!=='POST')return authError('method_not_allowed','Method Not Allowed',405);
 const body=await readAuthBody(request),email=String(body.email??'').trim().toLowerCase();
 if(!validEmail(email))return authError('invalid_email','邮箱格式不正确');
 const ip=request.headers.get('cf-connecting-ip')||'local';
 if(!await authLimit(env.DB,`email-request:${ip}`,40))return authError('auth_rate_limited','操作过于频繁，请稍后重试',429);
 if(path==='/auth/email-code'){
  const purpose=body.purpose;
  if(!['signup','login','reset'].includes(purpose))return authError('invalid_purpose','验证用途无效');
  if(!await verifyTurnstile(env,request,body['cf-turnstile-response'],purpose==='signup'?'register':'login'))return authError('human_verification_failed','人机验证失败，请重试',403);
  if(!await authLimit(env.DB,`email-send:${email}:${purpose}`,6))return authError('auth_rate_limited','验证码发送过于频繁，请稍后重试',429);
  const user=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if(purpose==='signup'&&user)return authError('email_registered','该邮箱已注册，请直接登录',409);
  if(purpose!=='signup'&&!user)return authJSON({ok:true});
  if(!env.RESEND_API_KEY)return authError('email_unavailable','邮件服务暂不可用',503);
  const now=Date.now(),code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
  // Reserve the cooldown atomically before sending. Concurrent requests cannot flood the mailbox.
  const reserved=await env.DB.prepare('INSERT INTO auth_email_codes(email,user_id,purpose,code_hash,expires_at,sent_at,attempts) VALUES(?,?,?,?,?,?,0) ON CONFLICT(email,purpose) DO UPDATE SET user_id=excluded.user_id,code_hash=excluded.code_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0 WHERE auth_email_codes.sent_at<=? RETURNING code_hash').bind(email,user?.id??null,purpose,await digest(`${purpose}:${email}:${code}`),now+600000,now,now-60000).first();
  if(!reserved)return authError('email_cooldown','发送过于频繁，请稍后再试',429);
  const label=purpose==='signup'?'注册':purpose==='reset'?'重置密码':'登录';
  let sent=false;
  try{
   const result=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${env.RESEND_API_KEY}`,'content-type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({from:'Tora <noreply@ohfun.online>',to:[email],subject:`Tora ${label}验证码：${code}`,html:`<div style="font-family:system-ui;max-width:480px;margin:auto;padding:32px"><h2>Tora ${label}验证码</h2><p>请使用以下六位验证码，10 分钟内有效：</p><p style="font-size:32px;letter-spacing:8px">${code}</p><p>如非本人操作，请忽略此邮件。请勿向他人透露验证码。</p></div>`})});sent=result.ok;
  }catch{/* No provider response or credentials are returned to the client. */}
  if(!sent){await env.DB.prepare('DELETE FROM auth_email_codes WHERE email=? AND purpose=? AND code_hash=?').bind(email,purpose,reserved.code_hash).run();return authError('email_unavailable','验证码发送失败，请稍后重试',502);}
  return authJSON({ok:true});
 }
 if(path==='/auth/reset-verify'){
  const proof=/^\d{6}$/.test(String(body.code??''))?await consumeEmailCode(env.DB,email,'reset',body.code):null;
  if(!proof||!proof.user_id)return authError('invalid_code','验证码错误或已过期');
  const token=randomToken();await env.DB.prepare('INSERT INTO auth_password_resets(token_hash,email,user_id,expires_at) VALUES(?,?,?,?)').bind(await digest(token),email,proof.user_id,Date.now()+300000).run();
  return authJSON({resetToken:token});
 }
 const purpose=path==='/auth/email-login'?'login':path==='/auth/signup'?'signup':path==='/auth/reset-password'?'reset':null;
 if(!purpose)return authError('not_found','Not Found',404);
 const password=String(body.password??'');
 if(purpose!=='login'&&(password.length<8||password.length>128))return authError('invalid_password','密码长度需为 8 至 128 位');
 let proof;
 if(purpose==='reset'){
  proof=await env.DB.prepare('DELETE FROM auth_password_resets WHERE token_hash=? AND email=? AND expires_at>? RETURNING email,user_id').bind(await digest(String(body.resetToken??'')),email,Date.now()).first();
  if(!proof)return authError('invalid_code','验证请求已过期，请重新获取验证码');
 }else{
  if(!/^\d{6}$/.test(String(body.code??'')))return authError('invalid_code','验证码错误或已过期');
  proof=await consumeEmailCode(env.DB,email,purpose,body.code);
  if(!proof)return authError('invalid_code','验证码错误或已过期');
 }
 let user=await env.DB.prepare(purpose==='signup'?'SELECT * FROM users WHERE email=?':'SELECT * FROM users WHERE email=? AND id=?').bind(...(purpose==='signup'?[email]:[email,proof.user_id??-1])).first();
 if(purpose==='signup'){
  if(user)return authError('email_registered','该邮箱已注册，请直接登录',409);
  const salt=await helpers.makeSalt(),hash=await helpers.hashPassword(password,salt),createdAt=new Date().toISOString();
  // New accounts sign in with email; existing usernames remain supported.
  try{
   const result=await env.DB.prepare('INSERT INTO users(email,salt,hash,created_at) VALUES(?,?,?,?)').bind(email,salt,hash,createdAt).run();
   user={id:result.meta.last_row_id,email,username:null,created_at:createdAt,avatar:null};
  }catch{return authError('email_registered','该邮箱已注册，请直接登录',409);}
  ctx?.waitUntil(helpers.sendWelcomeEmail(env,email).catch(()=>{}));
 }else if(!user)return authError('invalid_code','验证码错误或已过期');
 if(purpose==='reset'){
  const salt=await helpers.makeSalt(),hash=await helpers.hashPassword(password,salt);
  await env.DB.batch([env.DB.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').bind(salt,hash,user.id),env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id)]);
  return authJSON({ok:true});
 }
 const token=await helpers.createSession(env.DB,user.id,true);
 return authJSON(publicUser(user,token));
}
