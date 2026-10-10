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
export type ToChatModelId = (typeof TOCHAT_MODELS)[number]['id'] | typeof RETIRED_OPUS.id;
export const modelAllowedInMode = (id: string, mode: string) => id !== DOUBAO_MODEL_ID || mode === 'chat';
export const BUILTIN_CREDENTIAL_ID = 'tora-official';
export const isBuiltinCredential = (id?: string) => id === BUILTIN_CREDENTIAL_ID || id === 'tora-tochat-official';
export type AgentQuota = { remainingPercent: number; canUseAgent: boolean; chatUnlimited?: boolean; subscription: { planId: string; name: string; expiresAt: string } | null; windows: { key: 'fiveHour' | 'week' | 'month'; remainingPercent: number; resetAt: string | null }[] };
export type BuiltinQuota = AgentQuota & { enabled: boolean; models?: ToChatModelAvailability[] };
export type ToChatModelAvailability = { id: string; enabled: boolean };
export const toChatModel = (id?: string) => id === RETIRED_OPUS.id ? RETIRED_OPUS : TOCHAT_MODELS.find(model => model.id === id) ?? TOCHAT_MODELS.find(model => model.id === 'deepseek-flash')!;
export const modelAvailable = (id: string, models?: ToChatModelAvailability[]) => id !== RETIRED_OPUS.id && (models ? models.some(model => model.id === id && model.enabled) : id === 'deepseek-flash');

export type ToChatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const toChatEffort = (id: string, effort: string): ToChatEffort => {
	const levels: readonly string[] = toChatModel(id).efforts;
	return levels.includes(effort) ? effort as ToChatEffort : 'high';
};
