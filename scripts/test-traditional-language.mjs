import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applicationMenuTemplate, isTraditionalChineseLocale } from '../packages/desktop/application-menu.js';
import { normalizeNativeLanguage, nativeText } from '../packages/desktop/native-i18n.js';

const locale = name => JSON.parse(readFileSync(new URL(`../packages/desktop/frontend/src/i18n/locales/${name}.json`, import.meta.url), 'utf8'));
const leafKeys = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) =>
  item && typeof item === 'object' ? leafKeys(item, `${prefix}${key}.`) : [`${prefix}${key}`]).sort();

test('香港與台灣繁體中文均有完整詞條及地區名稱', () => {
  for (const code of ['zh-HK', 'zh-TW']) {
    assert.deepEqual(leafKeys(locale(code)), leafKeys(locale('zh')));
    assert.deepEqual(leafKeys(locale(code)), leafKeys(locale('en')));
    assert.equal(locale(code).settings.general.language.zhHK, '繁體中文（中國香港）');
    assert.equal(locale(code).settings.general.language.zhTW, '繁體中文（中國台灣）');
    const native=JSON.parse(readFileSync(new URL('../packages/desktop/native-locales.json',import.meta.url),'utf8'));
    assert.deepEqual(Object.keys(native[code]).sort(),Object.keys(native.en).sort());
  }
  assert.equal(locale('zh-HK').applicationModes.official, '官方 DeepSeek Flash（默認）');
  assert.equal(locale('zh-TW').applicationModes.official, '官方 DeepSeek Flash（預設）');
});

test('地區系統標籤與舊繁體偏好正確遷移', () => {
  for (const value of ['zh-HK', 'zh_HK', 'zh-Hant-HK', 'zh-MO', 'zh-Hant-MO']) assert.equal(normalizeNativeLanguage(value), 'zh-HK');
  for (const value of ['zh-TW', 'zh_Hant_TW', 'zh-Hant']) assert.equal(normalizeNativeLanguage(value), 'zh-TW');
  assert.equal(normalizeNativeLanguage('zh-CN'), 'zh');
});

test('原生選單識別繁體系統區域與應用語言', () => {
  assert.equal(isTraditionalChineseLocale('zh-TW'), true);
  assert.equal(isTraditionalChineseLocale('zh_HK'), true);
  assert.equal(isTraditionalChineseLocale('zh-Hant-MO'), true);
  assert.equal(isTraditionalChineseLocale('zh-CN'), false);
  const menu = applicationMenuTemplate({
    language: 'zh-Hant', isMac: true,
    send() {}, checkUpdates() {}, openWebsite() {}, openDownloads() {}, openLogs() {}, about() {},
  });
  assert.equal(menu[1].label, '檔案');
  assert.equal(menu[2].label, '編輯');
  assert.equal(menu[6].label, '說明');
  const hongkong = applicationMenuTemplate({language:'zh-HK',isMac:true,send(){},checkUpdates(){},openWebsite(){},openDownloads(){},openLogs(){},about(){}});
  assert.equal(hongkong[1].label,'文件');
  assert.equal(hongkong[6].label,'幫助');
  assert.equal(nativeText('zh-HK','You have a new message'),'收到一則 Tora 消息');
  assert.equal(nativeText('zh-TW','You have a new message'),'收到一則 Tora 訊息');
});
