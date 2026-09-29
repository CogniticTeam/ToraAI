// 已发布版本的内部存储身份。保持 macOS Safe Storage 密钥、Chromium
// profile 和历史登录数据可读；应用展示名称由 productName / 菜单 / 标题使用 Tora。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
export const DESKTOP_STORAGE_IDENTITY = 'CoCode';
export function desktopStorageName(appData, exists = existsSync) {
  return exists(join(appData, DESKTOP_STORAGE_IDENTITY)) ? DESKTOP_STORAGE_IDENTITY : 'Tora';
}
