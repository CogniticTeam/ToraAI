import { readFileSync } from 'node:fs';

const translations = JSON.parse(readFileSync(new URL('./native-locales.json', import.meta.url), 'utf8'));
const regionalConsent = JSON.parse(readFileSync(new URL('./region-consent-locales.json', import.meta.url), 'utf8'));
export const NATIVE_LANGUAGES = ['zh', 'zh-HK', 'zh-TW', 'en-GB', 'en-US', 'ja', 'ko', 'fr', 'de', 'it', 'ar', 'es', 'pt', 'ru', 'hi', 'lzh', 'zh-Neko', 'ja-Neko'];

export function normalizeNativeLanguage(value = '') {
  const normalized = String(value).trim().replaceAll('_', '-').toLowerCase();
  if (/^en-(?:gb|uk)(?:-|$)/.test(normalized)) return 'en-GB';
  if (/^en(?:-|$)/.test(normalized)) return 'en-US';
  if (normalized === 'zh-neko') return 'zh-Neko';
  if (normalized === 'ja-neko') return 'ja-Neko';
  if (/^(?:lzh|zh-(?:classical|wenyan))(?:-|$)/.test(normalized)) return 'lzh';
  if (/^zh(?:-(?:hans|hant))?-(?:hk|mo)(?:-|$)/.test(normalized)) return 'zh-HK';
  if (/^zh(?:-hant|-tw)(?:-|$)/.test(normalized)) return 'zh-TW';
  if (normalized.startsWith('zh')) return 'zh';
  const base = normalized.split('-')[0];
  return NATIVE_LANGUAGES.includes(base) ? base : 'en-US';
}

export function nativeText(language, english) {
  const locale = normalizeNativeLanguage(language);
  const consentLocale = locale === 'zh-HK' ? 'zh-TW' : locale;
  return translations[locale]?.[english] || regionalConsent[consentLocale]?.[english] || english;
}
