#!/usr/bin/env node
// Generate complete UI locale drafts from the existing English/Chinese catalogs.
// Results are checked before a locale file is written; cached chunks allow resume.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/core/src/config.js';

const root = fileURLToPath(new URL('../packages/desktop/frontend/src/i18n/locales/', import.meta.url));
const cacheRoot = fileURLToPath(new URL('../output/i18n-translation-cache/', import.meta.url));
const targetNames = {
  ja: 'Japanese (日本語)', ko: 'Korean (한국어)', fr: 'French (Français)',
  de: 'German (Deutsch)', it: 'Italian (Italiano)', ar: 'Arabic (العربية)',
  es: 'Spanish (Español)', pt: 'Portuguese (Português)', ru: 'Russian (Русский)',
  hi: 'Hindi (हिन्दी)', lzh: 'Classical Chinese (文言文)'
};
const nativeOnly = process.argv.includes('--native-only');
const requested = process.argv.slice(2).filter((argument) => argument !== '--native-only');
const targets = requested.length ? requested : Object.keys(targetNames);
if (targets.some((target) => !(target in targetNames))) throw new Error(`未知目标语言：${targets.join(', ')}`);
const batchSize = 90;
const config = loadConfig();
const apiKey = process.env.TORA_API_KEY || config.apiKey;
if (!apiKey) throw new Error('需要 TORA_API_KEY 或现有 Tora 模型配置');
const baseURL = (process.env.TORA_BASE_URL || config.baseURL).replace(/\/+$/, '');
const model = process.env.TORA_MODEL || config.model;

function flatten(value, path = [], out = []) {
  if (typeof value === 'string') out.push({ id: String(out.length), path, source: value });
  else if (Array.isArray(value)) value.forEach((item, index) => flatten(item, [...path, index], out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => flatten(item, [...path, key], out));
  return out;
}

const placeholders = (value) => [...String(value).matchAll(/\{\{\s*[^{}]+?\s*\}\}/g)].map(([match]) => match.replace(/\s+/g, '')).sort();
const tags = (value) => [...String(value).matchAll(/<\/?[A-Za-z][^>]*>/g)].map(([match]) => match).sort();
const inlineCode = (value) => [...String(value).matchAll(/`[^`]+`/g)].map(([match]) => match).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validate(batch, output) {
  if (!output || typeof output !== 'object') throw new Error('译文不是 JSON 对象');
  const expected = batch.map((item) => item.id).sort();
  if (!same(Object.keys(output).sort(), expected)) throw new Error('译文 ID 集合不匹配');
  for (const item of batch) {
    const translation = output[item.id];
    if (typeof translation !== 'string' || (!translation.trim() && item.source.trim())) throw new Error(`${item.id} 译文为空`);
    if (!same(placeholders(item.source), placeholders(translation))) throw new Error(`${item.id} 插值占位符不匹配`);
    if (!same(tags(item.source), tags(translation))) throw new Error(`${item.id} HTML 标签不匹配`);
    if (!same(inlineCode(item.source), inlineCode(translation))) throw new Error(`${item.id} 行内代码不匹配`);
    if (item.source.includes('Tora') && !translation.includes('Tora')) throw new Error(`${item.id} 产品名 Tora 被改动`);
  }
  return output;
}

async function requestTranslation(locale, batch, attempt) {
  const system = `You are a professional software-localization translator. Translate every string into ${targetNames[locale]}. Return only a JSON object with a "translations" object mapping each supplied numeric id to one translated string. Keep translations concise, natural for a desktop coding assistant, and faithful to the original meaning. Preserve every {{placeholder}}, HTML tag, backtick-enclosed code token, keyboard shortcut, product name Tora, URL, file extension and line break exactly. Never omit an id. Translate content inside arrays as ordinary UI copy. ${locale === 'lzh' ? 'Use concise, readable Classical Chinese (文言文), not modern Mandarin; retain technical names and interpolation tokens.' : ''} ${locale === 'ar' ? 'Use Modern Standard Arabic suitable for a right-to-left interface.' : ''}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature: 0, enable_thinking: false, response_format: { type: 'json_object' },
        max_tokens: attempt > 1 ? 12000 : 9000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify({ target: locale, strings: Object.fromEntries(batch.map(({ id, source }) => [id, source])) }) }
        ]
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${payload.error?.message || 'translation request failed'}`);
    const raw = payload.choices?.[0]?.message?.content;
    if (!raw) throw new Error('模型未返回正文');
    const parsed = JSON.parse(raw);
    return validate(batch, parsed.translations ?? parsed);
  } finally {
    clearTimeout(timeout);
  }
}

async function translateBatch(locale, batch, batchIndex) {
  const folder = join(cacheRoot, locale);
  const path = join(folder, `${batchIndex}.json`);
  const sourceHash = createHash('sha256').update(JSON.stringify({ locale, model, batch })).digest('hex');
  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8'));
      if (cached.sourceHash === sourceHash) return validate(batch, cached.translations);
    }
    catch { /* Regenerate stale or invalid cache. */ }
  }
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const result = await requestTranslation(locale, batch, attempt);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path, JSON.stringify({ sourceHash, translations: result }));
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`${locale} chunk ${batchIndex} attempt ${attempt}: ${error?.message || error}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(6000, 500 * 2 ** attempt)));
    }
  }
  throw new Error(`${locale} chunk ${batchIndex} failed: ${lastError?.message || lastError}`);
}

function setAt(rootValue, path, value) {
  let cursor = rootValue;
  for (const key of path.slice(0, -1)) cursor = cursor[key];
  cursor[path.at(-1)] = value;
}

function completePluralForms(locale, catalog) {
  if (locale === 'ar') {
    Object.assign(catalog.tool.read, {
      fileCount_zero: '{{count}} ملفات', fileCount_two: '{{count}} ملفان',
      fileCount_few: '{{count}} ملفات', fileCount_many: '{{count}} ملفًا',
      lineCount_zero: 'قراءة {{formatted}} أسطر', lineCount_two: 'قراءة {{formatted}} سطرين',
      lineCount_few: 'قراءة {{formatted}} أسطر', lineCount_many: 'قراءة {{formatted}} سطرًا',
    });
    Object.assign(catalog.knowledge.document, {
      chunkCount_zero: '{{count}} مقاطع', chunkCount_two: '{{count}} مقطعان',
      chunkCount_few: '{{count}} مقاطع', chunkCount_many: '{{count}} مقطعًا',
    });
  }
  if (locale === 'ru') {
    Object.assign(catalog.tool.read, {
      fileCount_few: '{{count}} файла', fileCount_many: '{{count}} файлов', fileCount_other: '{{count}} файла',
      lineCount_few: 'Прочитано {{formatted}} строки', lineCount_many: 'Прочитано {{formatted}} строк',
      lineCount_other: 'Прочитано {{formatted}} строки',
    });
    Object.assign(catalog.knowledge.document, {
      chunkCount_few: '{{count}} чанка', chunkCount_many: '{{count}} чанков', chunkCount_other: '{{count}} чанка',
    });
  }
}

async function translateLocale(locale) {
  const sourceLocale = locale === 'lzh' ? 'zh' : 'en';
  const source = JSON.parse(readFileSync(join(root, `${sourceLocale}.json`), 'utf8'));
  const entries = flatten(source);
  const batches = [];
  for (let i = 0; i < entries.length; i += batchSize) batches.push(entries.slice(i, i + batchSize));
  const translations = {};
  let nextBatch = 0;
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const index = nextBatch++;
      if (index >= batches.length) return;
      Object.assign(translations, await translateBatch(locale, batches[index], index));
      console.log(`${locale}: ${index + 1}/${batches.length}`);
    }
  });
  await Promise.all(workers);
  const result = structuredClone(source);
  for (const entry of entries) setAt(result, entry.path, translations[entry.id]);
  const translated = flatten(result);
  if (translated.length !== entries.length) throw new Error(`${locale}: key count changed`);
  translated.forEach((item, index) => validate([entries[index]], { [entries[index].id]: item.source }));
  completePluralForms(locale, result);
  writeFileSync(join(root, `${locale}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(`${locale}: wrote ${entries.length} translated strings`);
}

async function translateNativeLocale(locale) {
  const menuSource = readFileSync(new URL('../packages/desktop/application-menu.js', import.meta.url), 'utf8');
  const labels = [...menuSource.matchAll(/(?:label|command)\('[^']*',\s*'([^']+)'/g)].map((match) => match[1]);
  const english = [...new Set([
    ...labels, 'You have a new message', 'Tora is up to date',
    'Updates are disabled in development', 'Unable to check for updates'
  ])];
  const batch = english.map((source, index) => ({ id: String(index), source }));
  const translations = await translateBatch(locale, batch, 'native');
  const path = fileURLToPath(new URL('../packages/desktop/native-locales.json', import.meta.url));
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { en: Object.fromEntries(english.map((source) => [source, source])) };
  existing.en = Object.fromEntries(english.map((source) => [source, source]));
  existing[locale] = Object.fromEntries(batch.map((entry) => [entry.source, translations[entry.id]]));
  writeFileSync(path, JSON.stringify(existing, null, 2) + '\n');
  console.log(`${locale}: wrote ${batch.length} native labels`);
}

for (const locale of targets) {
  if (!nativeOnly) await translateLocale(locale);
  await translateNativeLocale(locale);
}
