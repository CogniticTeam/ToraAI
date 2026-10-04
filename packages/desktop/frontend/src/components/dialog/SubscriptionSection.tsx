import {Check,MessageCircle,Terminal,Sparkles} from 'lucide-react';
import {useCallback,useEffect,useState} from 'react';

import {AgentQuotaMeter} from '@/components/chat/AgentQuotaMeter';
import {Button} from '@/components/ui/button';
import {useTranslation} from '@/i18n/useI18n';
import {openSettings} from '@/lib/openSettings';
import {nextUpgrade,planLabel} from '@/lib/subscription';
import type {AgentQuota} from '@/lib/tochatModels';
import {cloudFetch} from '@/utils/modelSync';
type Plan={id:string;name:string;price:number;usd:number;rank:number;windows:string[]};
type Subscription=AgentQuota&{plans:Plan[]};
const CHECKOUT_KEY='tora:subscription-checkout';
export function SubscriptionSection(){
 const {t}=useTranslation();const [data,setData]=useState<Subscription|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[paymentUrl,setPaymentUrl]=useState(''),[pending,setPending]=useState(()=>localStorage.getItem(CHECKOUT_KEY));
 const refresh=useCallback(async()=>{try{const response=await cloudFetch('/billing/subscription',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error(t('subscription.unavailable'));setData(await response.json());setError('');}catch(e){setError((e as Error).message);}},[t]);
 useEffect(()=>{void refresh();},[refresh]);
 const sync=useCallback(async()=>{if(!pending)return;try{const response=await cloudFetch('/billing/sync',{method:'POST',body:JSON.stringify({checkoutId:pending}),signal:AbortSignal.timeout(15000)});const body=await response.json();if(!response.ok)throw Error(body.detail||t('subscription.unavailable'));if(body.paid){localStorage.removeItem(CHECKOUT_KEY);setPending(null);window.dispatchEvent(new Event('tora-subscription-changed'));await refresh();}setError('');}catch(e){setError((e as Error).message);}},[pending,refresh,t]);
 useEffect(()=>{if(!pending)return;void sync();const timer=window.setInterval(()=>void sync(),30000);return()=>window.clearInterval(timer);},[pending,sync]);
 async function buy(planId:string){setBusy(true);setError('');const popup='toraWindow' in window?null:window.open('about:blank','_blank');if(popup)popup.opener=null;try{const response=await cloudFetch('/billing/checkout',{method:'POST',body:JSON.stringify({planId})});const body=await response.json();if(!response.ok)throw Error(body.detail||t('subscription.unavailable'));if(body.requiresRedemption){localStorage.removeItem(CHECKOUT_KEY);setPending(null);}else{localStorage.setItem(CHECKOUT_KEY,body.id);setPending(body.id);}const target=new URL(body.url);if(target.protocol!=='https:'||target.hostname!=='afdian.com')throw Error(t('subscription.unavailable'));setPaymentUrl(body.url);if(popup)popup.location.href=body.url;else window.open(body.url,'_blank','noopener,noreferrer');}catch(e){popup?.close();setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="space-y-6" aria-label={t('subscription.title')}><div className="mx-auto max-w-lg"><AgentQuotaMeter quota={data}/></div>{data?.subscription&&<p className="text-xs text-muted-foreground">{t('subscription.expires',{time:new Date(data.subscription.expiresAt).toLocaleDateString()})}</p>}
 <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{data?.plans.map(plan=>{
 const recommended=nextUpgrade(data.subscription?.planId)===plan.id,current=data.subscription?.planId===plan.id;
 return <article key={plan.id} className={`flex min-h-[390px] flex-col rounded-3xl border p-6 ${recommended?'border-blue-500 bg-gradient-to-b from-blue-500/5 to-blue-500/20':'border-border bg-card'}`}>
 <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">{planLabel(plan.id)}</h3>{(recommended||current)&&<span className={`rounded-full px-2 py-1 text-xs ${recommended?'bg-blue-500/15 text-blue-600 dark:text-blue-300':'bg-muted text-muted-foreground'}`}>{t(current?'subscription.current':'subscription.recommended')}</span>}</div>
 <h4 className="mt-7 text-2xl font-semibold tracking-tight">{t(`subscription.plan${plan.id}`)}</h4><p className="mt-3 min-h-12 text-sm leading-6 text-muted-foreground">{plan.windows.map(key=>t(`subscription.${key}`)).join(' · ')}</p>
 <Button className={`my-6 w-full rounded-full ${recommended?'bg-blue-500 text-white hover:bg-blue-600':''}`} variant={recommended?'default':'outline'} disabled={busy||!!(data.subscription&&data.plans.find(item=>item.id===data.subscription?.planId)!.rank>plan.rank)} onClick={()=>void buy(plan.id)}>{recommended&&<Sparkles className="size-4"/>}{t(current?'subscription.renew':'subscription.buy')}</Button>
 <p className="flex items-baseline gap-1"><span className="text-xl">¥</span><span className="text-4xl font-medium tracking-tight">{plan.price}</span><span className="ms-1 text-sm text-muted-foreground">{t('subscription.perMonth')}</span></p>
 <ul className="mt-6 space-y-4 text-sm leading-6"><li className="flex items-start gap-3"><Terminal className="mt-1 size-4 shrink-0"/><span>{t('subscription.shared')}</span></li><li className="flex items-start gap-3"><MessageCircle className="mt-1 size-4 shrink-0"/><span>{t('subscription.chatFree')}</span></li><li className="flex items-start gap-3"><Check className="mt-1 size-4 shrink-0"/><span>DeepSeek Flash · Gemini 3.8 Flash · GPT-6.1 Sol</span></li></ul>
 </article>;
 })}</div>
 {paymentUrl&&<><p className="text-sm text-muted-foreground">{t('subscription.orderHelp')}</p><Button variant="outline" onClick={()=>openSettings('account')}>{t('subscription.redeem')}</Button><a href={paymentUrl} target="_blank" rel="noopener noreferrer" className="block text-sm underline">{t('subscription.buy')}</a></>}
 {pending&&<p className="text-xs text-muted-foreground">{t('subscription.awaiting')} <button type="button" className="underline" onClick={()=>void sync()}>{t('subscription.checkPayment')}</button></p>}
 {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}<p className="text-xs text-muted-foreground">{t('subscription.chatFree')}</p><Button variant="ghost" size="sm" onClick={()=>void refresh()}>{t('applicationModes.retry')}</Button></section>;
}
