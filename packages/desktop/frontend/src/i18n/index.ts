import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { normalizeLanguage, SUPPORTED_LANGUAGES, type AppLanguage } from './languages';
import enTranslations from './locales/en.json';
import zhHantTranslations from './locales/zh-Hant.json';
import zhTranslations from './locales/zh.json';

export { LANGUAGE_OPTIONS, normalizeLanguage, SUPPORTED_LANGUAGES } from './languages';
export type { AppLanguage } from './languages';

/** 只有用户主动切换后才写入；系统自动检测结果不会持久化。 */
export const LANGUAGE_PREFERENCE_KEY = 'tora_language_preference';

export function getSystemLocale(): string | null {
	const desktopLocale = typeof window === 'undefined'
		? null
		: (window as unknown as {
			toraWindow?: { getSystemLocale?: () => string };
		}).toraWindow?.getSystemLocale?.();
	if (desktopLocale) return desktopLocale;
	if (typeof navigator === 'undefined') return null;
	return navigator.languages?.[0] ?? navigator.language ?? null;
}

export function getSystemLanguage(): AppLanguage {
	return normalizeLanguage(getSystemLocale()) ?? 'en';
}

export function getInitialLanguage(): AppLanguage {
	if (typeof localStorage !== 'undefined') {
		const preference = normalizeLanguage(localStorage.getItem(LANGUAGE_PREFERENCE_KEY));
		if (preference) return preference;
	}
	return getSystemLanguage();
}

const localeLoaders: Partial<Record<AppLanguage, () => Promise<{ default: Record<string, unknown> }>>> = {
	ja: () => import('./locales/ja.json'),
	ko: () => import('./locales/ko.json'),
	fr: () => import('./locales/fr.json'),
	de: () => import('./locales/de.json'),
	it: () => import('./locales/it.json'),
	ar: () => import('./locales/ar.json'),
	es: () => import('./locales/es.json'),
	pt: () => import('./locales/pt.json'),
	ru: () => import('./locales/ru.json'),
	hi: () => import('./locales/hi.json'),
	lzh: () => import('./locales/lzh.json'),
};

const initPromise = i18n.use(initReactI18next)
	.init({
		resources: {
			en: { translation: enTranslations },
			zh: { translation: zhTranslations },
			'zh-Hant': { translation: zhHantTranslations },
		},
		lng: getInitialLanguage(),
		fallbackLng: { 'zh-Hant': ['zh', 'en'], lzh: ['zh', 'en'], default: ['en'] },
		supportedLngs: SUPPORTED_LANGUAGES,
		load: 'currentOnly',
		interpolation: {
			escapeValue: false,
		},
	});

async function ensureLanguageResources(language: AppLanguage): Promise<void> {
	if (i18n.hasResourceBundle(language, 'translation')) return;
	const load = localeLoaders[language];
	if (!load) throw new Error(`Missing translation loader for ${language}`);
	const { default: translations } = await load();
	i18n.addResourceBundle(language, 'translation', translations, true, true);
}

/** Finish loading the initial system/preferred locale before mounting React. */
export async function initializeI18n(): Promise<void> {
	await initPromise;
	const initial = getInitialLanguage();
	try {
		await ensureLanguageResources(initial);
		if (i18n.language !== initial) await i18n.changeLanguage(initial);
	} catch (error) {
		console.warn('[i18n] Could not load initial locale:', error);
		await i18n.changeLanguage('en');
	}
	syncDocumentLanguage(i18n.language);
}

function syncDocumentLanguage(language: string) {
	if (typeof document === 'undefined') return;
	document.documentElement.lang = normalizeLanguage(language) ?? 'en';
	document.documentElement.dir = normalizeLanguage(language) === 'ar' ? 'rtl' : 'ltr';
	(window as unknown as { toraWindow?: { reportLanguage?: (language: string) => void } })
		.toraWindow?.reportLanguage?.(normalizeLanguage(language) ?? 'en');
}

syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

/** 应用内所有手动语言入口都必须走这里，明确覆盖系统语言。 */
export async function setAppLanguage(language: string): Promise<void> {
	const next = normalizeLanguage(language) ?? 'en';
	await ensureLanguageResources(next);
	await i18n.changeLanguage(next);
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(LANGUAGE_PREFERENCE_KEY, next);
		// 清理旧版检测器自动写入的键，避免形成两套互相冲突的偏好。
		localStorage.removeItem('i18nextLng');
	}
}

export default i18n;
