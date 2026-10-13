import {KeyRound,Plus,Trash2} from 'lucide-react';
import {useCallback,useEffect,useRef,useState} from 'react';

import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {useTranslation} from '@/i18n/useI18n';
import {authRequest,beginPasskey,waitPasskey,cancelPasskeyRequest,AuthFlowError,type PasskeyHandoff} from '@/lib/authFlow';

interface PasskeyEntry {id:string;label:string;created_at:string;last_used_at:string|null}
export function PasskeyManager({email}:{email:string}){
 const{t,i18n}=useTranslation();const copy=useCallback((key:string)=>t(`authFlow.${key}`),[t]);
 const[keys,setKeys]=useState<PasskeyEntry[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
 const[open,setOpen]=useState(false),[selected,setSelected]=useState<PasskeyEntry|null>(null),[password,setPassword]=useState(''),[label,setLabel]=useState(''),[busy,setBusy]=useState(false),[flow,setFlow]=useState<PasskeyHandoff|null>(null);
 const pending=useRef<AbortController|null>(null),activeFlow=useRef<PasskeyHandoff|null>(null);
 const load=useCallback(async(signal?:AbortSignal)=>{setLoading(true);try{const result=await authRequest<{passkeys:PasskeyEntry[]}>('/account/passkeys',undefined,{authenticated:true,signal});if(!signal?.aborted){setKeys(result.passkeys);setError(null);}}catch{if(!signal?.aborted)setError(copy('errors.network'));}finally{if(!signal?.aborted)setLoading(false);}},[copy]);
 useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>{controller.abort();pending.current?.abort();if(activeFlow.current)void cancelPasskeyRequest(activeFlow.current);};},[email,load]);
 const close=()=>{pending.current?.abort();if(activeFlow.current)void cancelPasskeyRequest(activeFlow.current);activeFlow.current=null;setFlow(null);setPassword('');setBusy(false);setOpen(false);};
 const submit=async()=>{
  if(busy||!password)return;const controller=new AbortController();pending.current=controller;setBusy(true);setError(null);
  try{
   if(selected){await authRequest(`/account/passkeys/${encodeURIComponent(selected.id)}`,{password},{method:'DELETE',authenticated:true,signal:controller.signal});setNotice(copy('passkeyRemoved'));}
   else{
    const next=await beginPasskey('register',{password,label:label.trim()||copy('passkeyDefaultName'),language:i18n.language},controller.signal);activeFlow.current=next;setFlow(next);setPassword('');window.open(next.url,'_blank','noopener,noreferrer');
    const result=await waitPasskey(next,controller.signal);if(!result.registered)throw new AuthFlowError('passkey_failed');activeFlow.current=null;setNotice(copy('passkeyCreated'));
   }
   if(!controller.signal.aborted){setOpen(false);setPassword('');setFlow(null);await load(controller.signal);}
  }catch(cause){if(!controller.signal.aborted){const key=cause instanceof AuthFlowError?cause.code:'network';setError(t(`authFlow.errors.${key}`,{defaultValue:copy('errors.request_failed')}));}}
  finally{if(!controller.signal.aborted)setBusy(false);}
 };
 return <section className="mb-8" aria-labelledby="account-passkeys-title">
  <div className="mb-3 flex items-center justify-between gap-4"><h4 id="account-passkeys-title" className="text-[13px] font-semibold">{copy('passkeyManagerTitle')}</h4><Button variant="outline" size="sm" onClick={()=>{setSelected(null);setLabel('');setError(null);setOpen(true);}}><Plus className="size-4"/>{copy('passkeyAdd')}</Button></div>
  <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{copy('passkeyManagerDescription')}</p>
  <div className="divide-y divide-border rounded-2xl border border-border bg-card">
   {loading?<p role="status" className="p-5 text-sm text-muted-foreground">{t('common.loading')}</p>:keys.length?keys.map(key=><div key={key.id} className="flex items-center gap-3 px-5 py-4"><KeyRound className="size-4 shrink-0 text-muted-foreground"/><span className="min-w-0 flex-1 break-words text-sm">{key.label}</span><Button variant="ghost" size="icon-sm" aria-label={`${copy('passkeyRemove')} ${key.label}`} onClick={()=>{setSelected(key);setError(null);setOpen(true);}}><Trash2 className="size-4"/></Button></div>):<p className="p-5 text-sm text-muted-foreground">{copy('passkeyEmpty')}</p>}
  </div>
  {error&&!open&&<p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}{notice&&<p role="status" className="mt-3 text-xs text-muted-foreground">{notice}</p>}
  <Dialog open={open} onOpenChange={value=>{if(!value)close();}}><DialogContent><DialogHeader><DialogTitle>{copy(selected?'passkeyRemove':'passkeyAdd')}</DialogTitle><DialogDescription>{copy('passkeyPasswordHint')}</DialogDescription></DialogHeader>
   {flow?<><output dir="ltr" className="text-center text-2xl tracking-[6px]">{flow.confirmation}</output><a className="rounded-xl border border-border px-4 py-3 text-center text-sm underline" href={flow.url} target="_blank" rel="noopener noreferrer">{copy('openBrowser')}</a><p role="status" className="text-sm text-muted-foreground">{copy('passkeyWaiting')}</p></>:<form className="space-y-4" onSubmit={event=>{event.preventDefault();void submit();}}>
    {!selected&&<label className="block space-y-2 text-sm"><span>{copy('passkeyName')}</span><input value={label} onChange={event=>setLabel(event.target.value)} maxLength={60} className="h-11 w-full rounded-xl border border-border bg-background px-3"/></label>}
    <label className="block space-y-2 text-sm"><span>{copy('currentPassword')}</span><input type="password" value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password" maxLength={128} className="h-11 w-full rounded-xl border border-border bg-background px-3"/></label>
    <Button type="submit" className="w-full" disabled={busy||!password}>{copy(busy?'working':'continue')}</Button>
   </form>}
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="button" variant="ghost" onClick={close}>{copy('cancel')}</Button>
  </DialogContent></Dialog>
 </section>;
}
