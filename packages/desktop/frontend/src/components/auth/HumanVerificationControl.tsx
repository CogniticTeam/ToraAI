import { useRef, useState } from 'react';

import { Turnstile, type TurnstileHandle } from './Turnstile';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/useI18n';
import { verifyBuiltinHuman } from '@/utils/modelSync';

export function HumanVerificationControl({onVerified}:{onVerified:()=>void|Promise<unknown>}){
 const{t}=useTranslation();const[open,setOpen]=useState(false),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const widget=useRef<TurnstileHandle>(null);
 const submit=async()=>{
  if(!token||busy)return;setBusy(true);setError('');
  try{const response=await verifyBuiltinHuman(token);if(!response.ok||!(await response.json()).verified)throw Error('verification');await onVerified();setOpen(false);setToken('');}
  catch{setError(t('humanVerification.failed'));widget.current?.reset();}
  finally{setBusy(false);}
 };
 return <><div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"><span className="text-muted-foreground">{t('humanVerification.required')}</span><Button size="sm" onClick={()=>{setToken('');setError('');setOpen(true);}}>{t('settings.account.captchaTitle')}</Button></div><Dialog open={open} onOpenChange={value=>{if(!busy){setOpen(value);if(!value)setToken('');}}}><DialogContent className="max-w-sm" onEscapeKeyDown={event=>{if(busy)event.preventDefault();}} onInteractOutside={event=>{if(busy)event.preventDefault();}}><DialogHeader><DialogTitle>{t('settings.account.captchaTitle')}</DialogTitle><DialogDescription>{t('humanVerification.description')}</DialogDescription></DialogHeader><Turnstile ref={widget} action="free_trial" onToken={setToken}/>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={()=>setOpen(false)}>{t('common.cancel')}</Button><Button disabled={busy||!token} onClick={()=>void submit()}>{t(busy?'humanVerification.verifying':'humanVerification.continue')}</Button></div></DialogContent></Dialog></>;
}
