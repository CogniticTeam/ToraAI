#!/usr/bin/env node
// 检查最终 DMG 内的 App，而不是仅检查打包中间目录。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import desktop from '../packages/desktop/package.json' with { type: 'json' };

if (process.platform !== 'darwin') throw new Error('macOS 安装包验证必须在 macOS 上运行');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dmg = join(root, 'packages', 'desktop', 'release', `CoCode-${desktop.version}-mac.dmg`);
if (!existsSync(dmg)) throw new Error(`未找到安装包：${dmg}`);

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}

run('hdiutil', ['verify', dmg]);
console.log('✓ DMG 校验和有效');
const mountPoint = mkdtempSync(join(tmpdir(), 'cocode-release-verify-'));
let attached = false;
try {
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noverify', '-mountpoint', mountPoint, dmg]);
  attached = true;
  const app = join(mountPoint, 'CoCode.app');
  if (!existsSync(app)) throw new Error('DMG 内缺少 CoCode.app');
  run('codesign', ['--verify', '--deep', '--strict', app]);
  console.log('✓ 内层 App 签名有效');
  const assessment = run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  if (assessment && !/accepted/.test(assessment)) throw new Error(`Gatekeeper 未通过：${assessment}`);
  console.log('✓ Gatekeeper 接受安装包内的 App');
  const architectures = run('lipo', ['-archs', join(app, 'Contents', 'MacOS', 'CoCode')]).split(/\s+/);
  if (!['arm64', 'x86_64'].every((arch) => architectures.includes(arch))) throw new Error(`缺少通用架构：${architectures.join(', ')}`);
  console.log('✓ 同时包含 arm64 和 x86_64');
  const plist = join(app, 'Contents', 'Info.plist');
  const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  if (version !== desktop.version) throw new Error(`安装包版本 ${version} 与 package.json ${desktop.version} 不一致`);
  console.log(`✓ 版本 ${version}`);
  const minimum = run('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', plist]);
  if (minimum !== desktop.build.mac.minimumSystemVersion) throw new Error(`最低 macOS 版本 ${minimum} 与打包配置 ${desktop.build.mac.minimumSystemVersion} 不一致`);
  console.log(`✓ 最低 macOS ${minimum}`);
} finally {
  if (attached) {
    run('hdiutil', ['detach', mountPoint]);
    attached = false;
  }
  if (!attached) rmSync(mountPoint, { recursive: true, force: true });
}
