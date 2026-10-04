/** One catalog for the picker, Settings, system-locale detection and tests. */
export const LANGUAGE_OPTIONS = [
	{ value: 'en-GB', key: 'enGB', nativeName: 'English (UK)', englishName: 'English (United Kingdom)', chineseName: '英语（英国）', aliases: 'en-gb en-uk british uk 英國' },
	{ value: 'en-US', key: 'enUS', nativeName: 'English (US)', englishName: 'English (United States)', chineseName: '英语（美国）', aliases: 'en en-us american usa 美國' },
	{ value: 'zh', key: 'zh', nativeName: '简体中文', englishName: 'Simplified Chinese', chineseName: '简体中文', aliases: 'zh-cn zh-hans' },
	{ value: 'zh-HK', key: 'zhHK', nativeName: '繁體中文（中國香港）', englishName: 'Traditional Chinese (Hong Kong, China)', chineseName: '繁体中文（中国香港）', aliases: 'zh-hk zh-mo zh-hant-hk 香港 hong kong' },
	{ value: 'zh-TW', key: 'zhTW', nativeName: '繁體中文（中國台灣）', englishName: 'Traditional Chinese (Taiwan, China)', chineseName: '繁体中文（中国台湾）', aliases: 'zh-tw zh-hant zh-hant-tw 台湾 台灣 taiwan' },
	{ value: 'ja', key: 'ja', nativeName: '日本語', englishName: 'Japanese', chineseName: '日语', aliases: 'ja-jp' },
	{ value: 'ko', key: 'ko', nativeName: '한국어', englishName: 'Korean', chineseName: '韩语', aliases: 'ko-kr' },
	{ value: 'fr', key: 'fr', nativeName: 'Français', englishName: 'French', chineseName: '法语', aliases: 'fr-fr fr-ca' },
	{ value: 'de', key: 'de', nativeName: 'Deutsch', englishName: 'German', chineseName: '德语', aliases: 'de-de' },
	{ value: 'it', key: 'it', nativeName: 'Italiano', englishName: 'Italian', chineseName: '意大利语', aliases: 'it-it' },
	{ value: 'ar', key: 'ar', nativeName: 'العربية', englishName: 'Arabic', chineseName: '阿拉伯语', aliases: 'ar-sa ar-eg' },
	{ value: 'es', key: 'es', nativeName: 'Español', englishName: 'Spanish', chineseName: '西班牙语', aliases: 'es-es es-mx' },
	{ value: 'pt', key: 'pt', nativeName: 'Português', englishName: 'Portuguese', chineseName: '葡萄牙语', aliases: 'pt-br pt-pt' },
	{ value: 'ru', key: 'ru', nativeName: 'Русский', englishName: 'Russian', chineseName: '俄语', aliases: 'ru-ru' },
	{ value: 'hi', key: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi', chineseName: '印地语', aliases: 'hi-in' },
	{ value: 'lzh', key: 'lzh', nativeName: '文言文', englishName: 'Classical Chinese', chineseName: '文言文', aliases: 'zh-classical zh-wenyan' },
	{ value: 'zh-Neko', key: 'zhNeko', nativeName: '猫娘语（中文）', englishName: 'Catgirl Chinese', chineseName: '猫娘语（中文）', aliases: 'neko 喵喵喵 猫娘' },
	{ value: 'ja-Neko', key: 'jaNeko', nativeName: '猫娘語（日本語）', englishName: 'Catgirl Japanese', chineseName: '猫娘语（日语）', aliases: 'neko にゃにゃにゃ 猫娘語' },
] as const;

export type AppLanguage = (typeof LANGUAGE_OPTIONS)[number]['value'];
export const SUPPORTED_LANGUAGES: AppLanguage[] = LANGUAGE_OPTIONS.map((option) => option.value);

/** Display flags, independent of locale normalization and translation selection. */
export const LANGUAGE_FLAG_COUNTRIES = {
	'en-GB': 'gb', 'en-US': 'us', zh: 'cn', 'zh-HK': 'hk', 'zh-TW': 'cn',
	ja: 'jp', ko: 'kr', fr: 'fr', de: 'de', it: 'it', ar: 'sa',
	es: 'es', pt: 'pt', ru: 'ru', hi: 'in', lzh: 'cn',
	'zh-Neko': 'cn', 'ja-Neko': 'jp',
} as const satisfies Record<AppLanguage, string>;

export function availableLanguageOptions(catgirlInstalled: boolean) {
	return LANGUAGE_OPTIONS.filter(option => catgirlInstalled || !option.value.endsWith('-Neko'));
}

export function normalizeLanguage(value: string | null | undefined): AppLanguage | null {
	if (!value) return null;
	const normalized = value.trim().replaceAll('_', '-').toLowerCase();
	if (/^en-(?:gb|uk)(?:-|$)/.test(normalized)) return 'en-GB';
	// Keep old unqualified English preferences on the existing US copy.
	if (/^en(?:-|$)/.test(normalized)) return 'en-US';
	if (normalized === 'zh-neko') return 'zh-Neko';
	if (normalized === 'ja-neko') return 'ja-Neko';
	if (/^(?:lzh|zh-(?:classical|wenyan))(?:-|$)/.test(normalized)) return 'lzh';
	if (/^zh(?:-(?:hans|hant))?-(?:hk|mo)(?:-|$)/.test(normalized)) return 'zh-HK';
	// Legacy unqualified Traditional Chinese used the Taiwan vocabulary.
	if (/^zh(?:-hant|-tw)(?:-|$)/.test(normalized)) return 'zh-TW';
	if (normalized.startsWith('zh')) return 'zh';
	const base = normalized.split('-')[0];
	return SUPPORTED_LANGUAGES.find((language) => language === base) ?? null;
}

/** Account messages use the older API's language codes, independently of UI regions. */
export function messageTranslationLanguage(value: string | null | undefined): string | null {
	const language = normalizeLanguage(value);
	if (!language) return null;
	if (language.startsWith('en-')) return 'en';
	if (language === 'zh-HK' || language === 'zh-TW') return 'zh-Hant';
	if (language === 'zh-Neko') return 'zh';
	if (language === 'ja-Neko') return 'ja';
	return language;
}
