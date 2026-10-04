import type { AgentQuota } from './tochatModels';
export const OPEN_SUBSCRIPTION_EVENT = 'tora:open-subscription';
export const openSubscription = () => window.dispatchEvent(new Event(OPEN_SUBSCRIPTION_EVENT));
export type SubscriptionPlan = {id:string;name:string;price:number;usd:number;rank:number;windows:string[]};
export type SubscriptionState = AgentQuota & {plans:SubscriptionPlan[]};
export function nextUpgrade(planId?:string|null){return ({plus:'pro',pro:'max5',max5:'max20',max20:'ultra',ultra:null,ultrax:null} as Record<string,string|null>)[planId||'']??(planId==='ultra'||planId==='ultrax'?null:'plus');}
export const planLabel = (id:string) => ({plus:'Plus',pro:'Pro',max5:'Max 5x',max20:'Max 20x',ultra:'Ultra',ultrax:'Ultra x'} as Record<string,string>)[id];
