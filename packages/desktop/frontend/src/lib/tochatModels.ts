import {DOUBAO_MODEL_ID} from '../../../../core/src/chat-media.js';
/** Public model metadata only; credentials and upstream routing live in the Worker. */
export const TOCHAT_MODELS = [
	{ id: DOUBAO_MODEL_ID, name: 'Doubao Seed 2.1 Lite', efforts: ['low', 'medium', 'high'] as const },
	{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
	{ id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
	{ id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
	{ id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
	{ id: 'grok-4.7', name: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'] as const },
	{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
	{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
	{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
	{ id: 'glm-5.3', name: 'GLM 5.3', efforts: ['low', 'high', 'max'] as const },
	{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['low', 'high', 'max'] as const },
	{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] as const },
] as const;
// Preserve a retired selection's label until the user explicitly picks a
// replacement; never quietly render or bill it as DeepSeek.
const RETIRED_OPUS = {id:'claude-opus-5',name:'Claude Opus 5',efforts:['low','medium','high','xhigh','max']} as const;
export type ToChatModelId = string;
export const modelAllowedInMode = (id: string, mode: string, models?: ToChatModelAvailability[]) => models ? !!models.find(model=>model.id===id && (model.modes?.includes(mode) ?? (id!==DOUBAO_MODEL_ID||mode!=='tocode'))) : id !== DOUBAO_MODEL_ID || mode === 'chat' || mode === 'work';
export const BUILTIN_CREDENTIAL_ID = 'tora-official';
export const isBuiltinCredential = (id?: string) => id === BUILTIN_CREDENTIAL_ID || id === 'tora-tochat-official';
export type AgentQuota = { remainingPercent: number; canUseAgent: boolean; chatUnlimited?: boolean; subscription: { planId: string; name: string; expiresAt: string } | null; windows: { key: 'fiveHour' | 'week' | 'month'; remainingPercent: number; resetAt: string | null }[] };
export type ModelTrial = {model:string;total:number;used:number;remaining:number};
export type BuiltinQuota = AgentQuota & { catalogRevision?: number; enabled: boolean; models?: ToChatModelAvailability[]; trial?: ModelTrial; doubaoWork?: {total:number;used:number;remaining:number;resetAt:string;canUse:boolean}; humanVerification?: {required:boolean;verified:boolean;expiresAt:string|null} };
export const newerBuiltinQuota=(previous:BuiltinQuota|null,next:BuiltinQuota):BuiltinQuota=>previous?.catalogRevision!==undefined&&next.catalogRevision!==undefined&&next.catalogRevision<previous.catalogRevision?previous:next;
export type ToChatModelAvailability = { id: string; enabled: boolean; allowed?: boolean; workAllowed?: boolean; minimumPlan?: string | null; name?: string; provider?: string; context?: number; maxOutput?: number; efforts?: readonly string[]; input_modalities?: string[]; modes?: string[]; rates?: Record<string,number> };
export function officialModels(models?: ToChatModelAvailability[]) {
 return models ? models.map(model=>({...toChatModel(model.id),...model,name:model.name||toChatModel(model.id).name,efforts:model.efforts||toChatModel(model.id).efforts})).filter(model=>model.enabled) : TOCHAT_MODELS;
}
export function toChatModel(id?: string, models?: ToChatModelAvailability[]) {
 const fallback=id===RETIRED_OPUS.id?RETIRED_OPUS:TOCHAT_MODELS.find(model=>model.id===id);
 const model=models?.find(model=>model.id===id);
 return {id:id||'deepseek-flash',name:model?.name||fallback?.name||id||'DeepSeek Flash',efforts:model?.efforts||fallback?.efforts||['low','medium','high'],context:model?.context,provider:model?.provider};
}
export const modelAvailable = (id: string, models?: ToChatModelAvailability[], mode = 'chat') => id!==RETIRED_OPUS.id && (models ? models.some(model => model.id === id && model.enabled && model.allowed !== false && modelAllowedInMode(id,mode,models) && (mode === 'chat' || model.workAllowed !== false)) : id === 'deepseek-flash');
export type ToChatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const toChatEffort = (id: string, effort: string, models?: ToChatModelAvailability[]): ToChatEffort => {
 const levels: readonly string[] = toChatModel(id,models).efforts;
 return (levels.includes(effort) ? effort : levels.includes('high')?'high':levels[0]) as ToChatEffort;
};

export const canUseWorkModel = (id: string, quota?: BuiltinQuota | null, mode='work') => !!quota && modelAvailable(id,quota.models,mode) &&
 (id===DOUBAO_MODEL_ID ? (quota.subscription?quota.canUseAgent:!!quota.doubaoWork?.canUse) : quota.canUseAgent || (id==='deepseek-flash'&&!quota.subscription&&(quota.trial?.remaining||0)>0));
export function modelRequirementLabel(id: string, models: ToChatModelAvailability[] | undefined, t: (key:string,params?:Record<string,unknown>)=>string){
 const info=models?.find(model=>model.id===id);
 if(info?.allowed!==false||!info.minimumPlan)return '';
 const plan=({plus:'Plus',pro:'Pro',max5:'Max 5x'} as Record<string,string>)[info.minimumPlan]||info.minimumPlan;
 return t('llm-select.requiresPlan',{plan});
}

export const humanVerificationNeeded=(model:string,quota?:BuiltinQuota|null,mode='chat')=>!quota?.subscription&&((model==='deepseek-flash'&&(quota?.trial?.remaining||0)>0)||(model===DOUBAO_MODEL_ID&&mode==='work'&&!!quota?.doubaoWork?.canUse))&&!!quota?.humanVerification?.required&&!quota.humanVerification.verified;
