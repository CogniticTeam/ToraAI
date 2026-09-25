import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_DIRECTORY, resolveDataDirectory } from '../src/legacy-migration.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'cocode-migration-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = join(home, LEGACY_DIRECTORY);
  mkdirSync(join(old, 'sessions'), { recursive: true });
  writeFileSync(join(old, 'config.json'), '{"model":"saved-model"}');
  writeFileSync(join(old, 'sessions', 'saved.json'), '{"messages":["保留会话"]}');
  return { home, old, destination: join(home, '.cocode') };
}

test('首次迁移保留配置、会话、原目录，并清理暂存目录', t => {
  const { home, old, destination } = fixture(t);
  assert.equal(resolveDataDirectory({ env: {}, home }), destination);
  for (const file of ['config.json', 'sessions/saved.json']) {
    assert.equal(readFileSync(join(destination, file), 'utf8'), readFileSync(join(old, file), 'utf8'));
  }
  assert.deepEqual(readdirSync(home).sort(), ['.cocode', LEGACY_DIRECTORY].sort());
});

test('已有新目录优先，不覆盖或合并旧数据', t => {
  const { home, destination } = fixture(t);
  mkdirSync(destination);
  writeFileSync(join(destination, 'config.json'), '{"model":"new-model"}');
  resolveDataDirectory({ env: {}, home });
  assert.equal(readFileSync(join(destination, 'config.json'), 'utf8'), '{"model":"new-model"}');
  assert.equal(existsSync(join(destination, 'sessions')), false);
});

test('COCODE_HOME 隔离时不迁移用户目录', t => {
  const { home, destination } = fixture(t);
  const override = join(home, 'isolated');
  assert.equal(resolveDataDirectory({ env: { COCODE_HOME: override }, home }), override);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(override), false);
});

test('新用户选择新目录，无额外文件写入', t => {
  const { home, old, destination } = fixture(t);
  rmSync(old, { recursive: true });
  assert.equal(resolveDataDirectory({ env: {}, home }), destination);
  assert.deepEqual(readdirSync(home), []);
});

test('迁移保留符号链接，不递归读取链接目标', { skip: process.platform === 'win32' }, t => {
  const { home, old, destination } = fixture(t);
  symlinkSync('missing-target', join(old, 'reference'));
  resolveDataDirectory({ env: {}, home });
  assert.equal(readlinkSync(join(destination, 'reference')), 'missing-target');
});
