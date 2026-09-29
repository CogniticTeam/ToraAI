import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applicationMenuTemplate, isTraditionalChineseLocale } from '../packages/desktop/application-menu.js';

const locale = name => JSON.parse(readFileSync(new URL(`../packages/desktop/frontend/src/i18n/locales/${name}.json`, import.meta.url), 'utf8'));
const leafKeys = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) =>
  item && typeof item === 'object' ? leafKeys(item, `${prefix}${key}.`) : [`${prefix}${key}`]).sort();

test('繁體中文詞條與現有語言保持同一鍵集合', () => {
  assert.deepEqual(leafKeys(locale('zh-Hant')), leafKeys(locale('zh')));
  assert.deepEqual(leafKeys(locale('zh-Hant')), leafKeys(locale('en')));
  assert.equal(locale('zh-Hant').settings.general.language.zhHant, '繁體中文');
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
});
