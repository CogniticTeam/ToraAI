// 跨会话记忆存储（~/.vega/asapi/memories.json + memory-config.json）
// 存储模式与 store.js 相同（原子写 tmp+rename、损坏隔离 .corrupt-*），但自行实现：
// store.js 的 readJson/writeJson 为模块私有，且直接 import 会形成
// builtin.js → tools/memory.js → 本文件 → store.js → builtin.js 的循环引用。
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { VEGA_DIR } from '../config.js';

const ASAPI_DIR = join(VEGA_DIR, 'asapi');
const MEMORY_PATH = join(ASAPI_DIR, 'memories.json');
const CONFIG_PATH = join(ASAPI_DIR, 'memory-config.json');

export const MEMORY_LIMIT = 500;    // 每个 scope（global 一份 / 每个 project_key 一份）容量上限
export const CONTENT_MAX = 2000;    // 单条 content 字符上限
export const CONTEXT_BUDGET = 6000; // 注入系统提示的字符预算（≈1500 token）

export const MEMORY_KINDS = ['preference', 'fact', 'pitfall', 'convention'];
export const MEMORY_SCOPES = ['global', 'project'];
export const MEMORY_SOURCES = ['tool', 'distill', 'manual'];

const DEFAULT_CONFIG = { distill_enabled: false, inject_enabled: true };
const DEDUP_THRESHOLD = 0.85; // 字符 bigram Jaccard 相似度阈值，≥ 视为同一条

const now = () => new Date().toISOString();
const uid = () => randomUUID();

/** 参数不合法（API 层转 400，工具层转中文提示字符串）。 */
export class MemoryValidationError extends Error {}

// ---------- 存储（复刻 store.js 模式） ----------
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { }
    console.warn(`[memory] ${path.split('/').pop()} 解析失败，已隔离为 *.corrupt-* 以便人工恢复`);
    return fallback;
  }
}

function writeJson(path, data) {
  mkdirSync(ASAPI_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function readAll() {
  const data = readJson(MEMORY_PATH, { memories: [] });
  const list = data && Array.isArray(data.memories) ? data.memories : [];
  return list.filter((m) => m && typeof m === 'object' && typeof m.content === 'string');
}

const writeAll = (memories) => writeJson(MEMORY_PATH, { memories });

// ---------- 工具函数 ----------
const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
// 去重专用：空白在中文里无意义，直接删除，避免"同句不同空格"绕过合并
const normalizeCompact = (s) => String(s).toLowerCase().replace(/\s+/g, '');

function similarity(a, b) {
  const na = normalizeCompact(a);
  const nb = normalizeCompact(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const A = new Set();
  for (let i = 0; i < na.length - 1; i++) A.add(na.slice(i, i + 2));
  const B = new Set();
  for (let i = 0; i < nb.length - 1; i++) B.add(nb.slice(i, i + 2));
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

const scopeKeyOf = (m) => (m.scope === 'project' ? `project:${m.project_key || ''}` : 'global');

/** 每 scope 上限淘汰：updated_at 最旧的非置顶先走（全置顶时允许略超）。 */
function enforceLimit(list, scope, projectKey) {
  const key = scope === 'project' ? `project:${projectKey || ''}` : 'global';
  const inScope = list.filter((m) => scopeKeyOf(m) === key);
  if (inScope.length <= MEMORY_LIMIT) return list;
  const over = inScope.length - MEMORY_LIMIT;
  const candidates = inScope
    .filter((m) => !m.pinned)
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
  const kill = new Set(candidates.slice(0, over).map((m) => m.id));
  return kill.size ? list.filter((m) => !kill.has(m.id)) : list;
}

/** query 分词：空白切分后，CJK 连续段取 2-gram，其余整词（中英混合均可命中）。 */
function tokenize(query) {
  const out = new Set();
  const norm = normalize(query || '');
  if (!norm) return [];
  for (const word of norm.split(' ').filter(Boolean)) {
    const parts = word.match(/[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+/g) || [word];
    for (const p of parts) {
      if (/[\u4e00-\u9fff]/.test(p)) {
        if (p.length === 1) { out.add(p); continue; }
        for (let i = 0; i < p.length - 1; i++) out.add(p.slice(i, i + 2));
      } else {
        out.add(p);
      }
    }
  }
  return [...out].filter(Boolean);
}

/** 检索评分：term 命中×2 + 置顶×3 + 30 天线性时间衰减（0~1）；未命中一律 0 分。 */
function scoreOf(item, terms) {
  const text = normalize(item.content);
  let score = 0;
  for (const t of terms) if (text.includes(t)) score += 2;
  if (score === 0) return 0;
  if (item.pinned) score += 3;
  const age = (Date.now() - Date.parse(item.updated_at)) / 86400000;
  if (Number.isFinite(age)) score += Math.max(0, 1 - Math.min(Math.max(age, 0), 30) / 30);
  return score;
}

export const projectKeyOf = (cwd) => {
  if (!cwd || typeof cwd !== 'string') return '';
  try { return realpathSync(cwd); } catch { return cwd; }
};

const byNew = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at));

function assertContent(text) {
  if (typeof text !== 'string' || !text.trim()) throw new MemoryValidationError('content 不能为空');
  const t = text.trim();
  if (t.length > CONTENT_MAX) throw new MemoryValidationError(`content 超长（${t.length} > ${CONTENT_MAX} 字符），请精简为自包含的短句`);
  return t;
}

// ---------- CRUD ----------
/** 全部记忆：置顶在前，其余 updated_at 新→旧。 */
export function listMemories() {
  return readAll().sort((a, b) => (b.pinned - a.pinned) || byNew(a, b));
}

/**
 * 保存一条记忆（写入路径统一入口，工具 / 提炼 / API 手动创建共用）。
 * 同 scope 内 bigram Jaccard ≥ 0.85 视为同一条 → 更新 content/kind/updated_at，
 * pinned/source 保留原值。返回 { memory, deduped }。
 */
export function saveMemory({ content, kind = 'fact', scope, project_key = '', source = 'tool', pinned = false } = {}) {
  const text = assertContent(content);
  if (!MEMORY_KINDS.includes(kind)) throw new MemoryValidationError(`kind 只能是 ${MEMORY_KINDS.join(' / ')} 之一`);
  if (!MEMORY_SOURCES.includes(source)) throw new MemoryValidationError(`source 只能是 ${MEMORY_SOURCES.join(' / ')} 之一`);
  if (scope === undefined || scope === null || scope === '') {
    scope = project_key ? 'project' : 'global'; // 缺省时按 project_key 推断
  } else if (!MEMORY_SCOPES.includes(scope)) {
    throw new MemoryValidationError(`scope 只能是 ${MEMORY_SCOPES.join(' / ')} 之一`);
  }
  const key = scope === 'project' ? projectKeyOf(project_key) : '';
  const targetKey = scopeKeyOf({ scope, project_key: key });

  const list = readAll();
  let best = null;
  let bestScore = 0;
  for (const m of list) {
    if (scopeKeyOf(m) !== targetKey) continue;
    const s = similarity(m.content, text);
    if (s > bestScore) { bestScore = s; best = m; }
  }

  let memory;
  let deduped = false;
  if (best && bestScore >= DEDUP_THRESHOLD) {
    deduped = true;
    memory = { ...best, content: text, kind, updated_at: now() };
    list[list.indexOf(best)] = memory;
  } else {
    memory = {
      id: uid(),
      created_at: now(),
      updated_at: now(),
      scope,
      project_key: key,
      kind,
      source,
      pinned: !!pinned,
      content: text,
    };
    list.push(memory);
  }
  writeAll(enforceLimit(list, memory.scope, memory.project_key));
  return { memory, deduped };
}

/** 局部更新；id 不存在返回 null。可改 content/kind/scope/project_key/pinned。 */
export function updateMemory(id, patch = {}) {
  const list = readAll();
  const idx = list.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  const next = { ...list[idx] };
  if (patch.content !== undefined) next.content = assertContent(patch.content);
  if (patch.kind !== undefined) {
    if (!MEMORY_KINDS.includes(patch.kind)) throw new MemoryValidationError(`kind 只能是 ${MEMORY_KINDS.join(' / ')} 之一`);
    next.kind = patch.kind;
  }
  if (patch.scope !== undefined) {
    if (!MEMORY_SCOPES.includes(patch.scope)) throw new MemoryValidationError(`scope 只能是 ${MEMORY_SCOPES.join(' / ')} 之一`);
    next.scope = patch.scope;
  }
  if (patch.project_key !== undefined) next.project_key = projectKeyOf(patch.project_key);
  if (next.scope === 'global') next.project_key = '';
  if (patch.pinned !== undefined) next.pinned = !!patch.pinned;
  next.updated_at = now();
  list[idx] = next;
  writeAll(enforceLimit(list, next.scope, next.project_key));
  return next;
}

/** 删除单条；id 不存在返回 false。 */
export function deleteMemory(id) {
  const list = readAll();
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return false;
  writeAll(next);
  return true;
}

/** 本地评分检索：得分 > 0 才返回，limit 钳制到 [1, 50]。 */
export function searchMemories(query, { limit = 10 } = {}) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const max = Math.max(1, Math.min(Number(limit) || 10, 50));
  return readAll()
    .map((m) => ({ m, s: scoreOf(m, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || byNew(a.m, b.m))
    .slice(0, max)
    .map((x) => x.m);
}

// ---------- 配置 ----------
export function loadMemoryConfig() {
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ...DEFAULT_CONFIG };
  return {
    distill_enabled: !!cfg.distill_enabled,
    inject_enabled: cfg.inject_enabled === undefined ? true : !!cfg.inject_enabled,
  };
}

export function saveMemoryConfig(patch = {}) {
  const next = { ...loadMemoryConfig() };
  if (patch && typeof patch === 'object') {
    if ('distill_enabled' in patch) next.distill_enabled = !!patch.distill_enabled;
    if ('inject_enabled' in patch) next.inject_enabled = !!patch.inject_enabled;
  }
  writeJson(CONFIG_PATH, next);
  return next;
}

// ---------- 系统提示注入 ----------
/**
 * 拼装「置顶全部 + 当前 project + global」，组内 updated_at 新→旧，
 * 整块字符预算 CONTEXT_BUDGET，放不下的条目连同后续一并截断；
 * 无记忆（或一条都放不下）返回空串，不浪费 token。
 */
export function renderMemoryContext(cwd) {
  const all = readAll();
  if (!all.length) return '';
  const key = projectKeyOf(cwd);
  const pinned = all.filter((m) => m.pinned).sort(byNew);
  const proj = key
    ? all.filter((m) => !m.pinned && m.scope === 'project' && m.project_key === key).sort(byNew)
    : [];
  const glob = all.filter((m) => !m.pinned && m.scope === 'global').sort(byNew);

  let out = '## 长期记忆';
  let used = out.length;
  let any = false;
  for (const [label, items] of [['置顶', pinned], ['项目', proj], ['全局', glob]]) {
    if (!items.length) continue;
    const lines = [];
    for (const m of items) {
      const line = `- [${m.kind}] ${m.content}`;
      const cost = line.length + 1 + (lines.length === 0 ? label.length + 2 : 0);
      if (used + cost > CONTEXT_BUDGET) break;
      used += cost;
      lines.push(line);
    }
    if (lines.length) {
      out += `\n\n${label}：\n${lines.join('\n')}`;
      any = true;
    }
  }
  return any ? out : '';
}

/** 系统提示尾部的记忆使用指引（何时存、何时查、Forget 慎用）。 */
export const MEMORY_GUIDE = `## 记忆使用指引

你可以用 MemorySave / MemorySearch / MemoryList / MemoryForget 管理长期记忆（上文"长期记忆"块即当前相关记忆）：
- 存：用户明确表达稳定偏好、纠正你的做法、给出项目事实或踩坑教训时，主动 MemorySave（自包含短句，≤${CONTENT_MAX} 字符）；一次性任务细节不要存。
- 查：用户提到"之前/上次/还记得吗"，或接到与历史相关的新任务时，先 MemorySearch。
- 忘：仅在用户明确要求删除某条记忆时用 MemoryForget，不要自行清理。
- 重复保存相似内容会自动合并为一条。`;
