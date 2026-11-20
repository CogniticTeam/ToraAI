import {getToken} from '@/utils/authStore';
import {authBaseURL} from './toraService';
export {authBaseURL} from './toraService';

export interface AuthProfile {token:string;email:string;username?:string|null;createdAt?:string;avatar?:string|null}
export class AuthFlowError extends Error {code:string;constructor(code:string){super(code);this.name='AuthFlowError';this.code=code;}}
export async function authRequest<T>(path:string,body?:object,options:{authenticated?:boolean;signal?:AbortSignal;method?:string}={}):Promise<T>{
 let response:Response;
 try{response=await fetch(authBaseURL()+path,{method:options.method??(body?'POST':'GET'),headers:{'content-type':'application/json',...(options.authenticated?{authorization:`Bearer ${getToken()||''}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}catch(error){if(options.signal?.aborted)throw error;throw new AuthFlowError('network');}
 const result=await response.json().catch(()=>null);
 // A canceled response may finish parsing after navigation or an account switch.
 if(options.signal?.aborted)throw new DOMException('Canceled','AbortError');
 if(!response.ok||!result)throw new AuthFlowError(result?.code??(response.status===429?'rate_limited':response.status===401?'wrong_password':response.status===403?'human_verification_failed':'request_failed'));
 return result;
}
