/** Shared Turnstile widget. Tokens are single-use; errors and expiry clear them. */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { useTranslation } from '@/i18n/useI18n';

export const TURNSTILE_SITEKEY = '0x4AAAAAAE2FjA84FfwMA5BX';
const API_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
interface TurnstileApi { render:(el:HTMLElement,opts:Record<string,unknown>)=>string;reset:(id?:string)=>void;remove:(id?:string)=>void }
declare global { interface Window { turnstile?:TurnstileApi } }
let apiPromise:Promise<TurnstileApi>|null=null;
const ONLOAD_FN='__toraTurnstileOnload';
function loadTurnstileApi():Promise<TurnstileApi>{
 if(typeof window.turnstile?.render==='function')return Promise.resolve(window.turnstile);
 if(!apiPromise){
  apiPromise=new Promise((resolve,reject)=>{
   const script=document.createElement('script');let done=false;
   const fail=()=>{if(done)return;done=true;clearTimeout(timer);script.remove();apiPromise=null;reject(new Error('Turnstile unavailable'));};
   const timer=setTimeout(fail,20000);
   (window as unknown as Record<string,()=>void>)[ONLOAD_FN]=()=>{
    if(done)return;
    if(typeof window.turnstile?.render!=='function'){fail();return;}
    done=true;clearTimeout(timer);resolve(window.turnstile);
   };
   script.src=`${API_SRC}&onload=${ONLOAD_FN}`;script.async=true;script.defer=true;script.onerror=fail;document.head.appendChild(script);
  });
 }
 return apiPromise;
}
export interface TurnstileHandle { reset:()=>void }
type Status='loading'|'waiting'|'verified'|'failed'|'expired'|'timeout';
export const Turnstile=forwardRef<TurnstileHandle,{action:string;onToken:(token:string)=>void}>(({action,onToken},ref)=>{
 const{t}=useTranslation();const boxRef=useRef<HTMLDivElement>(null),widgetId=useRef<string|null>(null);
 const[status,setStatus]=useState<Status>('loading'),[attempt,setAttempt]=useState(0);
 const reset=useCallback(()=>{onToken('');if(widgetId.current&&window.turnstile){setStatus('waiting');window.turnstile.reset(widgetId.current);}else{setStatus('loading');setAttempt(n=>n+1);}},[onToken]);
 useImperativeHandle(ref,()=>({reset}),[reset]);
 useEffect(()=>{
  let disposed=false,id:string|null=null;
  void loadTurnstileApi().then(api=>{
   if(disposed||!boxRef.current)return;
   setStatus('waiting');
   const invalidate=(next:Status)=>{if(!disposed){onToken('');setStatus(next);}};
   id=api.render(boxRef.current,{sitekey:TURNSTILE_SITEKEY,action,size:'flexible',theme:document.documentElement.classList.contains('dark')?'dark':'light',
    callback:(token:string)=>{if(!disposed){onToken(token);setStatus('verified');}},
    'expired-callback':()=>invalidate('expired'),'timeout-callback':()=>invalidate('timeout'),
    'error-callback':()=>{invalidate('failed');return true;},
   });widgetId.current=id;
  }).catch(()=>{if(!disposed){onToken('');setStatus('failed');}});
  return()=>{disposed=true;widgetId.current=null;if(id)window.turnstile?.remove(id);};
 },[action,attempt,onToken]);
 const failed=['failed','expired','timeout'].includes(status);
 return <div className="mt-4 space-y-2"><div ref={boxRef} className="flex min-h-[65px] items-center justify-center"/><p role={failed?'alert':'status'} className={`text-center text-xs ${failed?'text-destructive':'text-muted-foreground'}`}>{t(`humanVerification.${status}`)}</p>{failed&&<button type="button" onClick={reset} className="mx-auto block rounded-md px-3 py-1.5 text-xs text-foreground hover:bg-muted">{t('error.retry')}</button>}</div>;
});
Turnstile.displayName='Turnstile';
