import {DOUBAO_MODEL_ID} from './chat-media.js';
export const PLAN_RANKS = Object.freeze({plus:1,pro:2,max5:3,max20:4,ultra:5,ultrax:6});
export const MODEL_MINIMUM_PLAN = Object.freeze({
 [DOUBAO_MODEL_ID]:null,
 'deepseek-flash':'plus',
 'gpt-6.1-sol':'plus','gpt-6-sol':'plus','gpt-6-luna':'plus',
 'grok-4.7':'plus','glm-5.3':'plus','gemini-3.8-flash':'plus',
 'claude-sonnet-5-5':'pro','claude-haiku-5-5':'pro',
 'gpt-6-astra':'max5','claude-opus-5-5':'max5',
});
export function hasModelSubscription(model,subscription){
 if(!Object.hasOwn(MODEL_MINIMUM_PLAN,model))return false;
 const required=MODEL_MINIMUM_PLAN[model];
 return required===null||(PLAN_RANKS[subscription?.planId]||0)>=(PLAN_RANKS[required]||Infinity);
}
