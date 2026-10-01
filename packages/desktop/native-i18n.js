import { readFileSync } from 'node:fs';

const translations = JSON.parse(readFileSync(new URL('./native-locales.json', import.meta.url), 'utf8'));
export const NATIVE_LANGUAGES = ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'it', 'ar', 'es', 'pt', 'ru', 'hi', 'lzh'];

export function normalizeNativeLanguage(value = '') {
  const normalized = String(value).trim().replaceAll('_', '-').toLowerCase();
  if (/^(?:lzh|zh-(?:classical|wenyan))(?:-|$)/.test(normalized)) return 'lzh';
  if (/^zh(?:-hant|-tw|-hk|-mo)(?:-|$)/.test(normalized)) return 'zh-Hant';
  if (normalized.startsWith('zh')) return 'zh';
  const base = normalized.split('-')[0];
  return NATIVE_LANGUAGES.includes(base) ? base : 'en';
}

export function nativeText(language, english) {
  return translations[normalizeNativeLanguage(language)]?.[english] || english;
}
