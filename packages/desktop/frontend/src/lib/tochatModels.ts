/** Public model metadata only; credentials and upstream routing live in the Worker. */
export const TOCHAT_MODELS = [
	{ id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: ['low', 'high', 'max'] as const },
	{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] as const },
	{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const },
] as const;
export type ToChatModelId = (typeof TOCHAT_MODELS)[number]['id'];
export const BUILTIN_CREDENTIAL_ID = 'tora-official';
export const isBuiltinCredential = (id?: string) => id === BUILTIN_CREDENTIAL_ID || id === 'tora-tochat-official';
export type AgentQuota = { remainingPercent: number; canUseAgent: boolean; chatUnlimited?: boolean; subscription: { planId: string; name: string; expiresAt: string } | null; windows: { key: 'fiveHour' | 'week' | 'month'; remainingPercent: number; resetAt: string | null }[] };
export type BuiltinQuota = AgentQuota & { enabled: boolean; models?: ToChatModelAvailability[] };
export type ToChatModelAvailability = { id: string; enabled: boolean };
export const toChatModel = (id?: string) => TOCHAT_MODELS.find(model => model.id === id) ?? TOCHAT_MODELS[0];
export const modelAvailable = (id: string, models?: ToChatModelAvailability[]) => models ? models.some(model => model.id === id && model.enabled) : id === 'deepseek-flash';

export type ToChatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const toChatEffort = (id: string, effort: string): ToChatEffort => {
	const levels: readonly string[] = toChatModel(id).efforts;
	return levels.includes(effort) ? effort as ToChatEffort : 'high';
};
