// 仅用于读取旧版本数据与保护旧凭证；所有新命名统一使用 CoCode。
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEGACY_AGENT_NAME = 'Vega';
export const LEGACY_ENV_PREFIX = 'VEGA';
export const LEGACY_DIRECTORY = '.vega';

// 显式指定数据目录时绝不读取真实用户目录。首次启动复制旧数据，
// 暂存完整后再切换；保留原目录，已有新目录优先且不覆盖。
export function resolveDataDirectory({ env = process.env, home = homedir() } = {}) {
  if (env.COCODE_HOME) return env.COCODE_HOME;
  const destination = join(home, '.cocode');
  const source = join(home, LEGACY_DIRECTORY);
  if (existsSync(destination) || !existsSync(source)) return destination;
  const staging = mkdtempSync(join(home, '.cocode-migration-'));
  try {
    const copy = join(staging, 'data');
    cpSync(source, copy, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    // 并发启动时不合并、不覆盖已经就绪的数据。
    if (!existsSync(destination)) {
      try { renameSync(copy, destination); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !existsSync(destination)) throw error;
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return destination;
}
