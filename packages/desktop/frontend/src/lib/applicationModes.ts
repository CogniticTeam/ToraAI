import i18n, { normalizeLanguage } from '@/i18n';

export type ApplicationMode = 'tochat' | 'tocode';
export type ToChatTask = 'chat' | 'work';
export type ToChatSource = 'official' | 'custom';
export const TOCHAT_SOURCE_KEY = 'tora_tochat_source';
export const TOCHAT_SOURCE_EVENT = 'tora:tochat-source-changed';

export function readToChatSource(): ToChatSource {
	return localStorage.getItem(TOCHAT_SOURCE_KEY) === 'custom' ? 'custom' : 'official';
}

export const MODE_COPY_KEYS = ["mode","chatDescription","codeDescription","chat","work","ready","workReady","quota","quotaLoading","quotaError","chatRemaining","workRemaining","chatLimit","dayLimit","weekLimit","reset","customQuota","retry","source","sourceHelp","official","custom","model","effort","low","medium","high","xhigh","max","search","searchOn","selectModel","syncError","connectError","limitReached","imageError","missingSession"] as const;
export type ModeCopyKey = typeof MODE_COPY_KEYS[number];

/** Uses the loaded locale for all mode text, including both ToChat greetings. */
export function modeCopy(language: string) {
	const locale = normalizeLanguage(language) ?? 'en-US';
	return (key: ModeCopyKey, count?: number | string): string =>
		i18n.t(`applicationModes.${key}`, { lng: locale, amount: count ?? '—' });
}
