import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { applicationMenuTemplate } from '../packages/desktop/application-menu.js';
import { createAccountMessageNotification } from '../packages/desktop/message-notifications.js';
import { normalizeNativeLanguage } from '../packages/desktop/native-i18n.js';

const locale = (name) => JSON.parse(readFileSync(new URL(`../packages/desktop/frontend/src/i18n/locales/${name}.json`, import.meta.url), 'utf8'));
const added = ['ja', 'ko', 'fr', 'de', 'it', 'ar', 'es', 'pt', 'ru', 'hi', 'lzh'];
const all = ['en', 'zh', 'zh-Hant', ...added];
const english = locale('en');
const requireFrontend = createRequire(new URL('../packages/desktop/frontend/package.json', import.meta.url));
const i18next = requireFrontend('i18next');
const pluralBases = ['tool.read.fileCount', 'tool.read.lineCount', 'knowledge.document.chunkCount'];

function flatten(value, path = '', out = {}) {
  if (typeof value === 'string') out[path] = value;
  else if (Array.isArray(value)) value.forEach((item, index) => flatten(item, `${path}.${index}`, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => flatten(item, path ? `${path}.${key}` : key, out));
  return out;
}

const markers = (value, pattern) => [...value.matchAll(pattern)].map(([match]) => match.replace(/\s+/g, '')).sort();

test('全部界面语言有同一词条和数组结构，插值与代码片段不丢失', () => {
  const expectedKeys = Object.keys(flatten(english)).sort();
  for (const name of all) {
    const source = name === 'lzh' ? flatten(locale('zh')) : flatten(english);
    const translated = flatten(locale(name));
    const extras = name === 'ar' ? pluralBases.flatMap((base) => ['zero', 'two', 'few', 'many'].map((form) => `${base}_${form}`))
      : name === 'ru' ? pluralBases.flatMap((base) => ['few', 'many'].map((form) => `${base}_${form}`)) : [];
    assert.deepEqual(Object.keys(translated).sort(), [...expectedKeys, ...extras].sort(), `${name} 的词条集合不完整`);
    let changed = 0;
    for (const key of expectedKeys) {
      const text = translated[key];
      assert.equal(typeof text, 'string', `${name}.${key} 应为字符串`);
      assert.ok(text.trim() || !source[key].trim(), `${name}.${key} 为空`);
      for (const pattern of [/\{\{\s*[^{}]+?\s*\}\}/g, /<\/?[A-Za-z][^>]*>/g, /`[^`]+`/g]) {
        assert.deepEqual(markers(text, pattern), markers(source[key], pattern), `${name}.${key} 的占位符或代码被改动`);
      }
      if (added.includes(name) && source[key].includes('Tora')) assert.ok(text.includes('Tora'), `${name}.${key} 丢失产品名`);
      if (text !== source[key]) changed++;
    }
    for (const key of extras) {
      const sourceKey = key.replace(/_(?:zero|two|few|many)$/, '_other');
      assert.deepEqual(markers(translated[key], /\{\{\s*[^{}]+?\s*\}\}/g),
        markers(source[sourceKey], /\{\{\s*[^{}]+?\s*\}\}/g), `${name}.${key} 的复数占位符不匹配`);
    }
    if (added.includes(name)) assert.ok(changed > expectedKeys.length * 0.6, `${name} 的译文覆盖不足`);
    for (const option of all) {
      const key = option === 'zh-Hant' ? 'zhHant' : option;
      assert.ok(locale(name).settings.general.language[key], `${name} 缺少 ${option} 的语言名称`);
    }
    assert.ok(locale(name).languageDialog.search, `${name} 缺少语言搜索文案`);
  }
});

test('阿拉伯语和俄语的所有数量形式都能实际渲染', async () => {
  for (const name of ['ar', 'ru']) {
    const instance = i18next.createInstance();
    await instance.init({ lng: name, fallbackLng: false, resources: { [name]: { translation: locale(name) } } });
    for (const base of pluralBases) for (const count of [0, 1, 2, 3, 11, 21, 101]) {
      const value = instance.t(base, { count, formatted: String(count) });
      assert.ok(value && value !== base, `${name}.${base}(${count}) 回退成键名`);
    }
  }
});

test('新增语言的桌面菜单与通知词条均已本地化', () => {
  const native = JSON.parse(readFileSync(new URL('../packages/desktop/native-locales.json', import.meta.url), 'utf8'));
  const keys = Object.keys(native.en).sort();
  assert.ok(keys.length >= 40, '原生词条集不完整');
  for (const name of added) {
    assert.deepEqual(Object.keys(native[name] ?? {}).sort(), keys, `${name} 的原生词条不完整`);
    assert.ok(native[name].File && native[name]['You have a new message']);
    assert.ok(keys.filter((key) => native[name][key] !== key).length >= 20, `${name} 的原生译文覆盖不足`);
    const menu = applicationMenuTemplate({
      language: name, isMac: true,
      send() {}, checkUpdates() {}, openWebsite() {}, openDownloads() {}, openLogs() {}, about() {}
    });
    assert.equal(menu[1].label, native[name].File, `${name} 的原生菜单未应用译文`);
    class NotificationStub {
      static isSupported() { return true; }
      constructor(options) { this.options = options; }
      on() {}
    }
    const notice = createAccountMessageNotification({
      Notification: NotificationStub, window: { isDestroyed: () => false }, language: name
    });
    assert.equal(notice.options.body, native[name]['You have a new message']);
  }
  assert.equal(normalizeNativeLanguage('pt-BR'), 'pt');
  assert.equal(normalizeNativeLanguage('ar-SA'), 'ar');
  assert.equal(normalizeNativeLanguage('zh-TW'), 'zh-Hant');
  assert.equal(normalizeNativeLanguage('zh-wenyan'), 'lzh');
});
