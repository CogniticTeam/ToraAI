import {useCallback,useEffect,useState} from 'react';

import {AgentQuotaMeter} from '@/components/chat/AgentQuotaMeter';
import {Button} from '@/components/ui/button';
import {useTranslation} from '@/i18n/useI18n';
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
 async function buy(planId:string){setBusy(true);setError('');const popup='toraWindow' in window?null:window.open('about:blank','_blank');if(popup)popup.opener=null;try{const response=await cloudFetch('/billing/checkout',{method:'POST',body:JSON.stringify({planId})});const body=await response.json();if(!response.ok)throw Error(body.detail||t('subscription.unavailable'));localStorage.setItem(CHECKOUT_KEY,body.id);setPending(body.id);const target=new URL(body.url);if(target.protocol!=='https:'||target.hostname!=='afdian.com')throw Error(t('subscription.unavailable'));setPaymentUrl(body.url);if(popup)popup.location.href=body.url;else window.open(body.url,'_blank','noopener,noreferrer');}catch(e){popup?.close();setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="space-y-4 rounded-xl border border-border p-5" aria-label={t('subscription.title')}><h3 className="text-base font-semibold">{t('subscription.title')}</h3><AgentQuotaMeter quota={data}/>{data?.subscription&&<p className="text-xs text-muted-foreground">{t('subscription.expires',{time:new Date(data.subscription.expiresAt).toLocaleDateString()})}</p>}
 <div className="grid gap-3 sm:grid-cols-2">{data?.plans.map(plan=><div key={plan.id} className="space-y-2 rounded-lg bg-muted/50 p-4"><h4 className="font-medium">{plan.name}</h4><p className="text-xl font-semibold">¥{plan.price}<span className="ms-1 text-xs font-normal text-muted-foreground">{t('subscription.perMonth')}</span></p><p className="text-xs text-muted-foreground">{plan.windows.map(key=>t(`subscription.${key}`)).join(' · ')}</p><Button size="sm" className="w-full" disabled={busy||!!(data.subscription&&data.plans.find(item=>item.id===data.subscription?.planId)!.rank>plan.rank)} onClick={()=>void buy(plan.id)}>{t(data.subscription?.planId===plan.id?'subscription.renew':'subscription.buy')}</Button></div>)}</div>
 {paymentUrl&&<a href={paymentUrl} target="_blank" rel="noopener noreferrer" className="block text-sm underline">{t('subscription.buy')}</a>}
 {pending&&<p className="text-xs text-muted-foreground">{t('subscription.awaiting')} <button type="button" className="underline" onClick={()=>void sync()}>{t('subscription.checkPayment')}</button></p>}
 {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}<p className="text-xs text-muted-foreground">{t('subscription.chatFree')}</p><Button variant="ghost" size="sm" onClick={()=>void refresh()}>{t('applicationModes.retry')}</Button></section>;
}
