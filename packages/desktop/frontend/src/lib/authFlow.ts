import {getToken} from '@/utils/authStore';

export interface AuthProfile {token:string;email:string;username?:string|null;createdAt?:string;avatar?:string|null}
export interface PasskeyHandoff {id:string;pollSecret:string;url:string;confirmation:string;expiresAt:number}
export class AuthFlowError extends Error {code:string;constructor(code:string){super(code);this.name='AuthFlowError';this.code=code;}}
export function authBaseURL(){return (localStorage.getItem('tora_auth_api')||'https://tora.ohfun.online').replace(/\/+$/,'');}
export async function authRequest<T>(path:string,body?:object,options:{authenticated?:boolean;signal?:AbortSignal;method?:string}={}):Promise<T>{
 let response:Response;
 try{response=await fetch(authBaseURL()+path,{method:options.method??(body?'POST':'GET'),headers:{'content-type':'application/json',...(options.authenticated?{authorization:`Bearer ${getToken()||''}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}catch(error){if(options.signal?.aborted)throw error;throw new AuthFlowError('network');}
 const result=await response.json().catch(()=>null);
 if(!response.ok||!result)throw new AuthFlowError(result?.code??(response.status===429?'rate_limited':response.status===401?'wrong_password':response.status===403?'human_verification_failed':'request_failed'));
 return result;
}
export async function beginPasskey(purpose:'login'|'register',values:{account?:string;password?:string;label?:string;language?:string},signal:AbortSignal){
 const flow=await authRequest<PasskeyHandoff>('/auth/passkeys/start',{purpose,...values},{authenticated:purpose==='register',signal});
 const url=new URL(flow.url),base=new URL(authBaseURL());
 if((url.origin!==base.origin&&url.origin!=='https://tora.ohfun.online')||(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname)))throw new AuthFlowError('passkey_failed');
 return flow;
}
export async function waitPasskey(flow:PasskeyHandoff,signal:AbortSignal){
 const deadline=performance.now()+300000;
 while(!signal.aborted&&performance.now()<deadline){
  const result=await authRequest<{status:string}&Partial<AuthProfile>&{registered?:boolean}>('/auth/passkeys/poll',{id:flow.id,pollSecret:flow.pollSecret},{signal});
  if(result.status==='complete')return result;
  if(result.status==='consumed'||result.status==='failed'||result.status==='canceled')throw new AuthFlowError('passkey_failed');
  await new Promise<void>((resolve,reject)=>{const aborted=()=>{clearTimeout(timer);reject(new DOMException('Canceled','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},1500);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();});
 }
 throw new AuthFlowError(signal.aborted?'passkey_canceled':'passkey_expired');
}

export const cancelPasskeyRequest=(flow:PasskeyHandoff)=>authRequest('/auth/passkeys/cancel',{id:flow.id,pollSecret:flow.pollSecret}).catch(()=>{});
