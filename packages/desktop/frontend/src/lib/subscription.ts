import type { AgentQuota } from './tochatModels';
export const OPEN_SUBSCRIPTION_EVENT = 'tora:open-subscription';
export const openSubscription = () => window.dispatchEvent(new Event(OPEN_SUBSCRIPTION_EVENT));
export type SubscriptionPlan = {id:string;name:string;price:number;usd:number;rank:number;windows:string[]};
export type SubscriptionState = AgentQuota & {plans:SubscriptionPlan[]};
export function nextUpgrade(planId?:string|null){return ({plus:'pro',pro:'max5',max5:'max20',max20:'ultra',ultra:null,ultrax:null} as Record<string,string|null>)[planId||'']??(planId==='ultra'||planId==='ultrax'?null:'plus');}
export const planLabel = (id:string) => ({plus:'Plus',pro:'Pro',max5:'Max 5x',max20:'Max 20x',ultra:'Ultra',ultrax:'Ultra x'} as Record<string,string>)[id];

/** Keep nonzero remaining credit visible as at least 1%; only exhaustion reads 0%. */
export function formatQuotaPercent(value?:number|null){const percent=Math.max(0,Math.min(100,value||0));return `${percent>0?Math.max(1,Math.round(percent)):0}%`;}

/** Show the card's local expiration date with an explicit UTC offset. */
export function formatResetCardExpiry(value:number|string,language:string){
  const locale=language==='lzh'?'zh-Hant':language.replace(/-Neko$/i,'');
  const expiry=new Date(value);
  const day=new Intl.DateTimeFormat(locale,{month:'short',day:'numeric'}).format(expiry);
  const parts=new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).formatToParts(expiry);
  const zone=parts.find(part=>part.type==='timeZoneName')?.value;
  const time=parts.filter(part=>part.type!=='timeZoneName').map(part=>part.value).join('').trim();
  return `${day} ${zone} ${time}`;
}
