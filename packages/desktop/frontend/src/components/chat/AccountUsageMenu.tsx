import {useQuery,useQueryClient} from '@tanstack/react-query';
import {ChevronDown,Gauge,Sparkles} from 'lucide-react';
import {useEffect,useState} from 'react';

import {DropdownMenuItem,DropdownMenuSeparator} from '@/components/ui/dropdown-menu';
import {useTranslation} from '@/i18n/useI18n';
import {formatQuotaPercent,nextUpgrade,openSubscription,planLabel,type SubscriptionState} from '@/lib/subscription';
import {cloudFetch} from '@/utils/modelSync';
export function AccountUsageMenu(){
 const queryClient=useQueryClient();const {t,i18n}=useTranslation();const [expanded,setExpanded]=useState(true);
 const {data}=useQuery({queryKey:['account-subscription'],refetchInterval:2000,queryFn:async()=>{const response=await cloudFetch('/billing/subscription',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Subscription unavailable');return await response.json() as SubscriptionState;}});
 useEffect(()=>{if(data)queryClient.setQueryData(['builtin-quota'],(previous:unknown)=>previous?{...(previous as Record<string,unknown>),...data}:previous);},[data,queryClient]);
 const next=nextUpgrade(data?.subscription?.planId);
 return <><DropdownMenuSeparator/><DropdownMenuItem onSelect={event=>{event.preventDefault();setExpanded(value=>!value);}} aria-expanded={expanded} className="py-2 text-[13px]"><Gauge/><span className="flex-1 font-medium">{t('subscription.remaining')}</span><ChevronDown className={`size-3.5 transition-transform ${expanded?'':'-rotate-90'}`}/></DropdownMenuItem>
 {expanded&&<div className="space-y-2.5 px-3 py-2" data-testid="account-usage-windows">{!data?<p className="text-xs text-muted-foreground">{t('applicationModes.quotaLoading')}</p>:!data.subscription?<p className="text-xs text-muted-foreground">{t('subscription.none')}</p>:data.windows.map(window=><div key={window.key} className="space-y-1"><div className="flex items-center justify-between gap-3 text-xs"><span>{t(`subscription.${window.key}`)}</span><div className="flex gap-2 text-muted-foreground"><span>{formatQuotaPercent(window.remainingPercent)}</span>{window.resetAt&&<time dateTime={window.resetAt}>{new Intl.DateTimeFormat(i18n.language.replace(/-Neko$/i,''),{...(window.key==='fiveHour'?{hour:'2-digit',minute:'2-digit'}:{month:'short',day:'numeric'})}).format(new Date(window.resetAt))}</time>}</div></div><div role="progressbar" aria-label={t(`subscription.${window.key}`)} aria-valuenow={window.remainingPercent} aria-valuetext={formatQuotaPercent(window.remainingPercent)} aria-valuemin={0} aria-valuemax={100} className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground" style={{width:`${window.remainingPercent}%`}}/></div></div>)}</div>}
 {data&&next&&<DropdownMenuItem data-testid="upgrade-subscription" className="py-2 text-[13px]" onSelect={openSubscription}><Sparkles/><span>{t('subscription.upgradeTo',{plan:planLabel(next)})}</span></DropdownMenuItem>}
 </>;
}
