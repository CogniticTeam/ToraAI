import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import {authJSON,authError,authLimit,readAuthBody,randomToken,digest} from './auth-security.js';
import {passkeyPage} from './passkey-page.js';

export const encodeBytes=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export const decodeBytes=text=>Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
export function passkeyConfig(env){
 const origin=env.PASSKEY_ORIGIN||'https://tora.ohfun.online',rpID=env.PASSKEY_RP_ID||'ohfun.online',url=new URL(origin);
 if(url.origin!==origin||!(url.hostname===rpID||url.hostname.endsWith('.'+rpID))||(url.protocol!=='https:'&&!(env.TURNSTILE_DEV_BYPASS==='1'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw new Error('PASSKEY_CONFIG_INVALID');
 return{origin,rpID};
}
const profile=(user,token)=>({token,email:user.email,username:user.username,createdAt:user.created_at,avatar:user.avatar??null});
const idValid=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{16,2048}$/.test(id);

export async function handlePasskeys(request,env,url,helpers){
 const path=url.pathname,method=request.method,{origin,rpID}=passkeyConfig(env);
 if(path==='/auth/passkeys'&&method==='GET')return passkeyPage(env,url.searchParams.get('flow')||'',url.searchParams.get('lang')||'zh');
 if(path==='/account/passkeys'&&method==='GET'){
  const user=await helpers.userFromRequest(env.DB,request,true);if(!user)return authError('session_expired','请先登录',401);
  const {results}=await env.DB.prepare('SELECT id,label,created_at,last_used_at FROM passkeys WHERE user_id=? ORDER BY created_at').bind(user.id).all();return authJSON({passkeys:results});
 }
 if(path.startsWith('/account/passkeys/')&&method==='DELETE'){
  const user=await helpers.userFromRequest(env.DB,request,true);if(!user)return authError('session_expired','请先登录',401);
  const body=await readAuthBody(request);
  if(!await authLimit(env.DB,`passkey-delete:${user.id}`,5,300000))return authError('auth_rate_limited','操作过于频繁，请稍后重试',429);
  if(!await helpers.checkPassword(user.id,String(body.password??'')))return authError('wrong_password','当前密码不正确',403);
  const id=decodeURIComponent(path.slice('/account/passkeys/'.length));
  const row=await env.DB.prepare('DELETE FROM passkeys WHERE id=? AND user_id=? RETURNING id').bind(id,user.id).first();return row?authJSON({ok:true}):authError('passkey_not_found','通行密钥不存在',404);
 }
 if(method!=='POST')return authError('method_not_allowed','Method Not Allowed',405);
 const body=await readAuthBody(request),now=Date.now();
 if(path==='/auth/passkeys/start'){
  const ip=request.headers.get('cf-connecting-ip')||'local';
  if(!await authLimit(env.DB,`passkey-start:${ip}`,20))return authError('auth_rate_limited','操作过于频繁，请稍后重试',429);
  const purpose=body.purpose??'login';if(!['login','register'].includes(purpose))return authError('invalid_purpose','请求无效');
  let userId=null;
  if(purpose==='register'){
   const user=await helpers.userFromRequest(env.DB,request,true);if(!user)return authError('session_expired','请先登录',401);
   if(!await authLimit(env.DB,`passkey-register:${user.id}`,5,300000))return authError('auth_rate_limited','操作过于频繁，请稍后重试',429);
   if(!await helpers.checkPassword(user.id,String(body.password??'')))return authError('wrong_password','当前密码不正确',403);
   const count=await env.DB.prepare('SELECT COUNT(*) AS total FROM passkeys WHERE user_id=?').bind(user.id).first();if(count.total>=10)return authError('passkey_limit','最多可添加 10 个通行密钥');
   userId=user.id;
  }else if(body.account){
   const account=String(body.account).trim();const found=await env.DB.prepare(account.includes('@')?'SELECT id FROM users WHERE email=?':'SELECT id FROM users WHERE username=?').bind(account.includes('@')?account.toLowerCase():account).first();userId=found?.id??-1;
  }
  const id=randomToken(),pollSecret=randomToken(),confirmation=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
  const label=String(body.label||'Passkey').trim().slice(0,60);
  await env.DB.batch([env.DB.prepare('DELETE FROM passkey_challenges WHERE expires_at<=?').bind(now),env.DB.prepare('DELETE FROM passkey_handoffs WHERE expires_at<=?').bind(now),env.DB.prepare('INSERT INTO passkey_handoffs(id,poll_hash,purpose,user_id,label,confirmation,expires_at) VALUES(?,?,?,?,?,?,?)').bind(id,await digest(pollSecret),purpose,userId,label,confirmation,now+300000)]);
  const browserURL=new URL('/auth/passkeys',origin);browserURL.hash=new URLSearchParams({flow:id,lang:String(body.language||'zh').slice(0,20)}).toString();
  return authJSON({id,pollSecret,confirmation,url:browserURL.href,expiresAt:now+300000});
 }
 if(path==='/auth/passkeys/cancel'){
  if(!idValid(body.id)||!idValid(body.pollSecret))return authError('invalid_request','请求无效');
  await env.DB.batch([env.DB.prepare("UPDATE passkey_handoffs SET status='canceled' WHERE id=? AND poll_hash=? AND status='pending'").bind(body.id,await digest(body.pollSecret)),env.DB.prepare("DELETE FROM passkey_challenges WHERE flow_id=? AND EXISTS(SELECT 1 FROM passkey_handoffs WHERE id=? AND poll_hash=? AND status='canceled')").bind(body.id,body.id,await digest(body.pollSecret))]);
  return authJSON({ok:true});
 }
 if(path==='/auth/passkeys/poll'){
  if(!idValid(body.id)||!idValid(body.pollSecret))return authError('invalid_request','请求无效');
  const hash=await digest(body.pollSecret);
  const row=await env.DB.prepare('SELECT status,result FROM passkey_handoffs WHERE id=? AND poll_hash=? AND expires_at>?').bind(body.id,hash,now).first();
  if(!row)return authError('passkey_expired','通行密钥请求已过期，请重新开始',410);
  if(row.status!=='complete')return authJSON({status:['consumed','failed','canceled'].includes(row.status)?row.status:'pending'});
  const completed=await env.DB.prepare("UPDATE passkey_handoffs SET status='consumed',result=NULL WHERE id=? AND poll_hash=? AND expires_at>? AND status='complete' RETURNING id").bind(body.id,hash,now).first();
  if(!completed)return authJSON({status:'consumed'});
  return authJSON({status:'complete',...(row.result?JSON.parse(row.result):{})});
 }
 const flowId=body.flow;
 if(!idValid(flowId))return authError('invalid_request','请求无效');
 const flow=await env.DB.prepare("SELECT * FROM passkey_handoffs WHERE id=? AND status='pending' AND expires_at>?").bind(flowId,now).first();
 if(!flow)return authError('passkey_expired','通行密钥请求已过期，请重新开始',410);
 if(path==='/auth/passkeys/options'){
  if(!await authLimit(env.DB,`passkey-options:${flow.id}`,10,300000))return authError('auth_rate_limited','请求过于频繁',429);
  let options;
  if(flow.purpose==='register'){
   const user=await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(flow.user_id).first();if(!user)return authError('session_expired','请先登录',401);
   await env.DB.prepare('INSERT OR IGNORE INTO passkey_users(user_id,handle) VALUES(?,?)').bind(flow.user_id,encodeBytes(crypto.getRandomValues(new Uint8Array(32)))).run();
   const owner=await env.DB.prepare('SELECT handle FROM passkey_users WHERE user_id=?').bind(flow.user_id).first();
   const keys=await env.DB.prepare('SELECT id,transports FROM passkeys WHERE user_id=?').bind(flow.user_id).all();
   options=await generateRegistrationOptions({rpName:'Tora',rpID,userID:decodeBytes(owner.handle),userName:user.email,attestationType:'none',supportedAlgorithmIDs:[-7,-257],authenticatorSelection:{residentKey:'required',userVerification:'required'},excludeCredentials:keys.results.map(key=>({id:key.id,transports:JSON.parse(key.transports)})),timeout:120000});
  }else{
   const keys=flow.user_id===null?null:await env.DB.prepare('SELECT id,transports FROM passkeys WHERE user_id=?').bind(flow.user_id).all();
   options=await generateAuthenticationOptions({rpID,userVerification:'required',timeout:120000,...(keys?{allowCredentials:keys.results.map(key=>({id:key.id,transports:JSON.parse(key.transports)}))}:{})});
  }
  const id=randomToken();await env.DB.prepare('INSERT INTO passkey_challenges(id,challenge,purpose,user_id,flow_id,rp_id,origin,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,options.challenge,flow.purpose,flow.user_id,flow.id,rpID,origin,Math.min(flow.expires_at,now+120000)).run();
  return authJSON({id,options,purpose:flow.purpose,confirmation:flow.confirmation});
 }
 if(path!=='/auth/passkeys/verify')return authError('not_found','Not Found',404);
 if(!idValid(body.id))return authError('invalid_request','请求无效');
 const challenge=await env.DB.prepare('DELETE FROM passkey_challenges WHERE id=? AND flow_id=? AND expires_at>? RETURNING *').bind(body.id,flow.id,now).first();
 if(!challenge)return authError('invalid_challenge','验证请求已失效，请重试');
 let user,result,pendingCredential;
 try{
  if(flow.purpose==='register'){
   const proof=await verifyRegistrationResponse({response:body.response,expectedChallenge:challenge.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true});
   if(!proof.verified||!proof.registrationInfo)throw new Error('unverified');
   const info=proof.registrationInfo,key=info.credential;
   pendingCredential={key,info};
   result={registered:true};
  }else{
   const key=await env.DB.prepare('SELECT p.*,u.handle FROM passkeys p JOIN passkey_users u ON p.user_id=u.user_id WHERE p.id=?').bind(String(body.response?.id??'')).first();
   const userHandle=body.response?.response?.userHandle;
   if(!key||(flow.user_id!==null&&flow.user_id!==key.user_id)||(userHandle!=null&&userHandle!==key.handle)||(flow.user_id===null&&userHandle!==key.handle))throw new Error('unknown');
   const proof=await verifyAuthenticationResponse({response:body.response,expectedChallenge:challenge.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,credential:{id:key.id,publicKey:decodeBytes(key.public_key),counter:key.counter,transports:JSON.parse(key.transports)}});
   if(!proof.verified)throw new Error('unverified');
   const updated=await env.DB.prepare('UPDATE passkeys SET counter=?,last_used_at=? WHERE id=? AND counter=? RETURNING id').bind(proof.authenticationInfo.newCounter,new Date().toISOString(),key.id,key.counter).first();if(!updated)throw new Error('counter_changed');
   user=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(key.user_id).first();if(!user)throw new Error('unknown');
  }
 }catch{return authError('passkey_failed','通行密钥验证失败，请重试',400);}
 const claimed=await env.DB.prepare("UPDATE passkey_handoffs SET status='verifying' WHERE id=? AND status='pending' AND expires_at>? RETURNING id").bind(flow.id,Date.now()).first();if(!claimed)return authError('invalid_challenge','验证请求已失效，请重试');
 if(pendingCredential){
  const {key,info}=pendingCredential;
  try{
   const stored=await env.DB.prepare('INSERT INTO passkeys(id,user_id,public_key,counter,transports,device_type,backed_up,label,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM passkeys WHERE user_id=?)<10 RETURNING id').bind(key.id,flow.user_id,encodeBytes(key.publicKey),key.counter,JSON.stringify(key.transports??[]),info.credentialDeviceType,info.credentialBackedUp?1:0,flow.label,new Date().toISOString(),flow.user_id).first();
   if(!stored)throw new Error('limit');
  }catch{await env.DB.prepare("UPDATE passkey_handoffs SET status='failed' WHERE id=?").bind(flow.id).run();return authError('passkey_failed','无法添加此通行密钥，请重试');}
 }
 if(user)result=profile(user,await helpers.createSession(env.DB,user.id,false));
 await env.DB.prepare("UPDATE passkey_handoffs SET status='complete',result=? WHERE id=? AND status='verifying'").bind(JSON.stringify(result),flow.id).run();
 return authJSON({verified:true});
}
