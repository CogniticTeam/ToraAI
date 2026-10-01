// 每日用量持久化（使用统计的权威数据源）。
//
// 为什么存在：聊天的 token 用量之前只经 SSE 事件（modelCallEnd）推给前端就
// 丢弃，旧版运行记录也不是可靠的用量来源 —— 使用统计面板因此
// 几乎总是空的。现在 bridge 在每次模型调用/工具执行时写入这里，
// ~/.tora/usage/daily.json 永不清理（一年也就几十 KB）。
//
// 形状：{ 'YYYY-MM-DD': { tokens, runs, tools: {name: count}, models: {name: count} } }
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { TORA_DIR } from '../config.js';

const DIR = join(TORA_DIR, 'usage');
const FILE = join(DIR, 'daily.json');

// 累计消耗里程碑；最大 100 亿仍在 JS 安全整数范围内。
export const TOKEN_MILESTONES = [
  100_000, 1_000_000, 10_000_000, 100_000_000, 500_000_000,
  1_000_000_000, 2_000_000_000, 5_000_000_000, 10_000_000_000
];
const MILESTONE_META_KEY = '__tokenMilestones';

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
    const temp = `${FILE}.tmp`;
    writeFileSync(temp, JSON.stringify(cache));
    renameSync(temp, FILE);
    return true;
  } catch {
    // 统计写入失败绝不能影响聊天主流程；确认弹窗则需保留待确认状态。
    return false;
  }
}

function totalTokens(data) {
  let total = 0;
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('__') || !value || typeof value !== 'object') continue;
    const count = Number(value.tokens);
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

function milestoneState(data, baseline) {
  const existing = data[MILESTONE_META_KEY];
  if (existing?.version === 1 && Array.isArray(existing.pending) && Array.isArray(existing.acknowledged)) return existing;
  // 首次启用只把既有用量设为基线，不补弹过去累计达到的多档。
  const state = {
    version: 1,
    pending: [],
    acknowledged: TOKEN_MILESTONES.filter((threshold) => threshold <= baseline)
  };
  data[MILESTONE_META_KEY] = state;
  save();
  return state;
}

/** 未确认的里程碑会跨窗口重启保留；确认动作由 UI 显式提交。 */
export function usageMilestoneStatus() {
  const data = load();
  const total = totalTokens(data);
  const state = milestoneState(data, total);
  return { totalTokens: total, pending: [...state.pending] };
}

export function acknowledgeUsageMilestone(threshold) {
  if (!TOKEN_MILESTONES.includes(threshold)) return null;
  const data = load();
  const state = milestoneState(data, totalTokens(data));
  if (state.acknowledged.includes(threshold)) return true;
  if (!state.pending.includes(threshold)) return null;
  const beforePending = [...state.pending];
  const beforeAcknowledged = [...state.acknowledged];
  state.pending = state.pending.filter((value) => value !== threshold);
  state.acknowledged.push(threshold);
  if (!save()) {
    state.pending = beforePending;
    state.acknowledged = beforeAcknowledged;
    return false;
  }
  return true;
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
  const tokenDelta = Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0;
  const before = tokenDelta > 0 ? totalTokens(d) : 0;
  const milestones = tokenDelta > 0 ? milestoneState(d, before) : null;
  const k = dayKey(ts);
  const cur = d[k] ?? (d[k] = { tokens: 0, runs: 0, tools: {}, models: {} });
  cur.tokens = (Number(cur.tokens) || 0) + tokenDelta;
  cur.runs += runs;
  if (toolName) cur.tools[toolName] = (cur.tools[toolName] || 0) + 1;
  if (model) cur.models[model] = (cur.models[model] || 0) + 1;
  if (milestones) {
    const after = before + tokenDelta;
    for (const threshold of TOKEN_MILESTONES) {
      if (before < threshold && threshold <= after &&
          !milestones.pending.includes(threshold) && !milestones.acknowledged.includes(threshold)) {
        milestones.pending.push(threshold);
      }
    }
  }
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
  // 历史 traces 迁移属于既有用量，不作为新达到的里程碑弹窗。
  const milestones = d[MILESTONE_META_KEY];
  if (milestones?.version === 1 && Array.isArray(milestones.pending) && Array.isArray(milestones.acknowledged)) {
    const total = totalTokens(d);
    for (const threshold of TOKEN_MILESTONES) {
      if (threshold <= total && !milestones.pending.includes(threshold) &&
          !milestones.acknowledged.includes(threshold)) milestones.acknowledged.push(threshold);
    }
  }
  save();
}

/** 写入元标记（如 __tracesImported），立即落盘。 */
export function usageStoreMarkMeta(key, value) {
  const d = load();
  d[key] = value;
  save();
}
