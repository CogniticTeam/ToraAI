// 仅用于读取旧版本数据与保护旧凭证；所有新命名统一使用 Tora。
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEGACY_AGENT_NAME = 'Vega';
export const LEGACY_ENV_PREFIX = 'VEGA';
export const LEGACY_DIRECTORY = '.vega';
export const PREVIOUS_AGENT_NAME = 'CoCode';
export const PREVIOUS_ENV_PREFIX = 'COCODE';
export const PREVIOUS_DIRECTORY = '.cocode';

// 旧命令行和已配置的进程仍可工作；显式 TORA_* 始终优先。
export function applyLegacyEnvironment(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PREVIOUS_ENV_PREFIX + '_')) continue;
    const current = 'TORA' + key.slice(PREVIOUS_ENV_PREFIX.length);
    if (env[current] === undefined) env[current] = value;
  }
  return env;
}
applyLegacyEnvironment();

export function resolveProjectDataPath(cwd, ...parts) {
  const current = join(cwd, '.tora', ...parts);
  const previous = join(cwd, PREVIOUS_DIRECTORY, ...parts);
  return existsSync(current) || !existsSync(previous) ? current : previous;
}

// 显式指定数据目录时绝不读取真实用户目录。首次启动复制旧数据，
// 暂存完整后再切换；保留原目录，已有新目录优先且不覆盖。
export function resolveDataDirectory({ env = process.env, home = homedir() } = {}) {
  if (env.TORA_HOME) return env.TORA_HOME;
  if (env[PREVIOUS_ENV_PREFIX + '_HOME']) return env[PREVIOUS_ENV_PREFIX + '_HOME'];
  const destination = join(home, '.tora');
  const source = [PREVIOUS_DIRECTORY, LEGACY_DIRECTORY]
    .map(name => join(home, name)).find(path => existsSync(path));
  if (existsSync(destination) || !source) return destination;
  const staging = mkdtempSync(join(home, '.tora-migration-'));
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
