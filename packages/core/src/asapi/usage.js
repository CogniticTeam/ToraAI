// 使用统计（设置窗口「使用统计」板块的数据源）。
//
// 数据源与职责：
//   · ~/.cocode/usage/daily.json —— **权威 token/工具/模型来源**。bridge 在每次
//     模型调用结束、工具执行完成时实时写入（usage-store.js），不受 trace GC
//     影响。首次运行时会把历史 traces 里还能找到的用量一次性迁移进来。
//   · ~/.cocode/sessions/*.json —— 聊天总数、聊天时长（created/updated 独有）。
//
// 注意：token **只**从 daily.json 来 —— traces 与 bridge 记录的是同一批
// 调用，两边都算会双倍。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COCODE_DIR } from '../config.js';
import { usageStoreDaily, usageStoreMerge, usageStoreMarkMeta } from './usage-store.js';

const TRACES_DIR = join(COCODE_DIR, 'traces');
const SESSIONS_DIR = join(COCODE_DIR, 'sessions');

const DAY_MS = 86400_000;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readJsonLines(p) {
  let text;
  try { text = readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 崩溃截断行跳过 */ }
  }
  return out;
}

/**
 * 一次性迁移：traces 里残存的用量导入 daily.json（打标记，绝不重复导入）。
 * 背景：daily.json 上线前，token 只散落在 traces 里且 7 天 GC——不迁移的话
 * 老用户的面板仍是空的。
 */
function importTracesOnce(daily) {
  if (daily.__tracesImported === true) return;
  if (!existsSync(TRACES_DIR)) { usageStoreMarkMeta('__tracesImported', true); return; }
  let sessionDirs = [];
  try {
    sessionDirs = readdirSync(TRACES_DIR).filter((x) => { try { return statSync(join(TRACES_DIR, x)).isDirectory(); } catch { return false; } });
  } catch { sessionDirs = []; }
  for (const s of sessionDirs) {
    let files = [];
    try { files = readdirSync(join(TRACES_DIR, s)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const lines = readJsonLines(join(TRACES_DIR, s, f));
      const start = lines.find((l) => l.kind === 'run-start');
      const model = start?.meta?.model ?? null;
      const dayTokens = {};
      let tools = {};
      let runs = 0;
      if (start?.ts) { runs = 1; }
      for (const l of lines) {
        if (l.kind === 'response' && l.usage && l.ts) {
          const t = (l.usage.prompt_tokens || 0) + (l.usage.completion_tokens || 0);
          const k = dayKey(l.ts);
          dayTokens[k] = (dayTokens[k] || 0) + t;
        } else if (l.kind === 'tool' && l.name) {
          tools[l.name] = (tools[l.name] || 0) + 1;
        }
      }
      for (const [k, t] of Object.entries(dayTokens)) {
        usageStoreMerge(k, { tokens: t, runs, tools, models: model ? { [model]: 1 } : {} });
        runs = 0; // runs 只记到第一个日
      }
    }
  }
  usageStoreMarkMeta('__tracesImported', true);
}

/**
 * 聚合全部使用数据（纯读 + 可能的一次性迁移）。
 */
export function usageStats() {
  const daily = usageStoreDaily();
  importTracesOnce(daily);

  // ---- daily.json：token / 工具 / 模型 / 运行 ----
  const perDay = {}; // 'YYYY-MM-DD' -> { tokens, runs }
  const toolCounts = new Map();
  const modelCounts = new Map();
  let totalTokens = 0;
  let totalRuns = 0;
  let totalToolRuns = 0;
  for (const [k, v] of Object.entries(daily)) {
    if (!k || k.startsWith('__') || typeof v !== 'object') continue;
    const t = v.tokens || 0;
    const r = v.runs || 0;
    perDay[k] = { tokens: t, runs: r };
    totalTokens += t;
    totalRuns += r;
    for (const [name, n] of Object.entries(v.tools ?? {})) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + n);
      totalToolRuns += n;
    }
    for (const [name, n] of Object.entries(v.models ?? {})) {
      modelCounts.set(name, (modelCounts.get(name) ?? 0) + n);
    }
  }

  // ---- sessions：聊天数 / 时长 / 活跃日 ----
  const daySet = new Set(Object.keys(perDay));
  let chatCount = 0;
  let maxChatMs = 0;
  let files = [];
  try { files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { /* 无 sessions */ }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
      const created = Date.parse(s.created ?? '');
      const updated = Date.parse(s.updated ?? '');
      if (Number.isFinite(created)) {
        chatCount++;
        daySet.add(dayKey(created));
        if (Number.isFinite(updated) && updated >= created) {
          maxChatMs = Math.max(maxChatMs, updated - created);
        }
      }
    } catch { /* 单文件坏掉不影响整体 */ }
  }

  // ---- 连续天数 ----
  const days = [...daySet].sort();
  let longestStreak = 0;
  let curStreak = 0;
  let prev = null;
  for (const k of days) {
    const t = Date.parse(`${k}T00:00:00`);
    curStreak = prev !== null && t - prev === DAY_MS ? curStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, curStreak);
    prev = t;
  }
  let currentStreak = 0;
  {
    const today = Date.parse(`${dayKey(Date.now())}T00:00:00`);
    const set = new Set(days);
    let probe = set.has(dayKey(Date.now())) ? today : today - DAY_MS;
    while (set.has(dayKey(probe))) { currentStreak++; probe -= DAY_MS; }
  }

  let peakTokens = 0;
  for (const v of Object.values(perDay)) peakTokens = Math.max(peakTokens, v.tokens);

  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
  const topModels = [...modelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => ({ name, count }));

  return {
    totalTokens,
    peakTokens,
    totalRuns,
    totalToolRuns,
    chatCount,
    activeDays: days.length,
    maxChatMs,
    currentStreak,
    longestStreak,
    topTools,
    topModels,
    daily: Object.fromEntries(Object.entries(perDay).sort()),
    generatedAt: Date.now(),
    exists: existsSync(TRACES_DIR) || existsSync(SESSIONS_DIR) || Object.keys(perDay).length > 0,
  };
}
