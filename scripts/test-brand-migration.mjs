import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { desktopStorageName } from '../packages/desktop/brand-compat.js';
const code = readFileSync(new URL('../packages/desktop/frontend/public/brand-migration.js', import.meta.url), 'utf8');
function migrate(entries) {
  const values = new Map(entries);
  const storage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  vm.runInNewContext(code, { localStorage: storage });
  return values;
}
test('迁移主题、登录与同意设置，不删除历史键', () => {
  const values = migrate([
    ['cocode.theme', 'dark'],
    ['cocode_token', 'fixture-token'],
    ['cocode:first-use-consent:v1', '{"accepted":true}'],
    ['cocode_auth_api', 'https://cocode.ohfun.online'],
    ['other-app.theme', 'light'],
  ]);
  assert.equal(values.get('tora.theme'), 'dark');
  assert.equal(values.get('tora_token'), 'fixture-token');
  assert.equal(values.get('tora:first-use-consent:v1'), '{"accepted":true}');
  assert.equal(values.get('tora_auth_api'), 'https://tora.ohfun.online');
  assert.equal(values.get('cocode.theme'), 'dark');
  assert.equal(values.get('other-app.theme'), 'light');
});
test('重复迁移不覆盖 Tora 设置或用户自定义接口', () => {
  const values = migrate([
    ['cocode.theme', 'dark'], ['tora.theme', 'light'],
    ['cocode_auth_api', 'https://custom.example.test'],
  ]);
  assert.equal(values.get('tora.theme'), 'light');
  assert.equal(values.get('tora_auth_api'), 'https://custom.example.test');
});
test('存储被限制时仍能启动', () => {
  assert.doesNotThrow(() => vm.runInNewContext(code, {
    localStorage: { get length() { throw new Error('disabled'); } },
  }));
});
test('新用户使用 Tora 存储身份，旧用户保留密钥链与 profile 身份', () => {
  assert.equal(desktopStorageName('/app-data', () => false), 'Tora');
  assert.equal(desktopStorageName('/app-data', path => path === '/app-data/CoCode'), 'CoCode');
});
