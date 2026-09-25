// 每日用量持久化（使用统计的权威数据源）。
//
// 为什么存在：聊天的 token 用量之前只经 SSE 事件（modelCallEnd）推给前端就
// 丢弃，traces 侧只有 agent 运行才写且 GC 7 天清空 —— 使用统计面板因此
// 几乎总是空的。现在 bridge 在每次模型调用/工具执行时写入这里，
// ~/.cocode/usage/daily.json 永不清理（一年也就几十 KB）。
//
// 形状：{ 'YYYY-MM-DD': { tokens, runs, tools: {name: count}, models: {name: count} } }
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { COCODE_DIR } from '../config.js';

const DIR = join(COCODE_DIR, 'usage');
const FILE = join(DIR, 'daily.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!cache || typeof cache !== 'object') cache = {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache));
  } catch { /* 统计写入失败绝不能影响聊天主流程 */ }
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 记一笔用量（当日累加）。字段都可缺省，按需记录。
 * bridge 在 modelCallEnd / tool-result 处调用。
 */
export function recordUsage({ tokens = 0, runs = 0, toolName = null, model = null, ts = Date.now() } = {}) {
  if (!tokens && !runs && !toolName && !model) return;
  const d = load();
  const k = dayKey(ts);
  const cur = d[k] ?? (d[k] = { tokens: 0, runs: 0, tools: {}, models: {} });
  cur.tokens += tokens;
  cur.runs += runs;
  if (toolName) cur.tools[toolName] = (cur.tools[toolName] || 0) + 1;
  if (model) cur.models[model] = (cur.models[model] || 0) + 1;
  save();
}

/** 读取全部每日用量（usage.js 聚合用）。 */
export function usageStoreDaily() {
  return load();
}

/** 供一次性迁移写入（usage.js 导入历史 traces 时用）。 */
export function usageStoreMerge(dayKeyStr, patch) {
  const d = load();
  const cur = d[dayKeyStr] ?? (d[dayKeyStr] = { tokens: 0, runs: 0, tools: {}, models: {} });
  cur.tokens += patch.tokens || 0;
  cur.runs += patch.runs || 0;
  for (const [name, n] of Object.entries(patch.tools ?? {})) {
    cur.tools[name] = (cur.tools[name] || 0) + n;
  }
  for (const [name, n] of Object.entries(patch.models ?? {})) {
    cur.models[name] = (cur.models[name] || 0) + n;
  }
  save();
}

/** 写入元标记（如 __tracesImported），立即落盘。 */
export function usageStoreMarkMeta(key, value) {
  const d = load();
  d[key] = value;
  save();
}
