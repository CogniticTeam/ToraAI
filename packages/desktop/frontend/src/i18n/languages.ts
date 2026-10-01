/** One catalog for the picker, Settings, system-locale detection and tests. */
export const LANGUAGE_OPTIONS = [
	{ value: 'en', key: 'en', nativeName: 'English', englishName: 'English', chineseName: '英语', aliases: 'en-us en-gb' },
	{ value: 'zh', key: 'zh', nativeName: '简体中文', englishName: 'Simplified Chinese', chineseName: '简体中文', aliases: 'zh-cn zh-hans' },
	{ value: 'zh-Hant', key: 'zhHant', nativeName: '繁體中文', englishName: 'Traditional Chinese', chineseName: '繁体中文', aliases: 'zh-tw zh-hk zh-mo zh-hant' },
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
] as const;

export type AppLanguage = (typeof LANGUAGE_OPTIONS)[number]['value'];
export const SUPPORTED_LANGUAGES: AppLanguage[] = LANGUAGE_OPTIONS.map((option) => option.value);

export function normalizeLanguage(value: string | null | undefined): AppLanguage | null {
	if (!value) return null;
	const normalized = value.trim().replaceAll('_', '-').toLowerCase();
	if (/^(?:lzh|zh-(?:classical|wenyan))(?:-|$)/.test(normalized)) return 'lzh';
	if (/^zh(?:-hant|-tw|-hk|-mo)(?:-|$)/.test(normalized)) return 'zh-Hant';
	if (normalized.startsWith('zh')) return 'zh';
	const base = normalized.split('-')[0];
	return SUPPORTED_LANGUAGES.find((language) => language === base) ?? null;
}
