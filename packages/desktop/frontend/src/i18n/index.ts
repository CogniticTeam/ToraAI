import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import enTranslations from './locales/en.json';
import zhTranslations from './locales/zh.json';

export type AppLanguage = 'zh' | 'en';

/** 只有用户主动切换后才写入；系统自动检测结果不会持久化。 */
export const LANGUAGE_PREFERENCE_KEY = 'cocode_language_preference';

function normalizeLanguage(value: string | null | undefined): AppLanguage | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (normalized.startsWith('zh')) return 'zh';
	if (normalized.startsWith('en')) return 'en';
	return null;
}

export function getSystemLanguage(): AppLanguage {
	const desktopLocale = typeof window === 'undefined'
		? null
		: (window as unknown as {
			cocodeWindow?: { getSystemLocale?: () => string };
		}).cocodeWindow?.getSystemLocale?.();
	if (desktopLocale) return normalizeLanguage(desktopLocale) ?? 'en';
	if (typeof navigator === 'undefined') return 'en';
	const primary = navigator.languages?.[0] ?? navigator.language;
	return normalizeLanguage(primary) ?? 'en';
}

export function getInitialLanguage(): AppLanguage {
	if (typeof localStorage !== 'undefined') {
		const preference = normalizeLanguage(localStorage.getItem(LANGUAGE_PREFERENCE_KEY));
		if (preference) return preference;
	}
	return getSystemLanguage();
}

i18n.use(initReactI18next)
	.init({
		resources: {
			en: { translation: enTranslations },
			zh: { translation: zhTranslations },
		},
		lng: getInitialLanguage(),
		fallbackLng: 'en',
		supportedLngs: ['zh', 'en'],
		load: 'languageOnly',
		interpolation: {
			escapeValue: false,
		},
	});

function syncDocumentLanguage(language: string) {
	if (typeof document === 'undefined') return;
	document.documentElement.lang = normalizeLanguage(language) ?? 'en';
	(window as unknown as { cocodeWindow?: { reportLanguage?: (language: string) => void } })
		.cocodeWindow?.reportLanguage?.(normalizeLanguage(language) ?? 'en');
}

syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

/** 应用内所有手动语言入口都必须走这里，明确覆盖系统语言。 */
export async function setAppLanguage(language: string): Promise<void> {
	const next = normalizeLanguage(language) ?? 'en';
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(LANGUAGE_PREFERENCE_KEY, next);
		// 清理旧版检测器自动写入的键，避免形成两套互相冲突的偏好。
		localStorage.removeItem('i18nextLng');
	}
	await i18n.changeLanguage(next);
}

export default i18n;
