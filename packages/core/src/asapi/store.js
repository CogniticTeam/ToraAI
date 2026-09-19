// ASAPI 存储：agents / credentials / sessions（~/.vega/asapi/）
// sessions 双轨存储：internal（OpenAI 格式，供 runAgent/压缩治理）+ display（agentscope Msg[]，供前端）
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig, VEGA_DIR } from '../config.js';
// 规则里的工具名必须归一化到 PascalCase，否则 decidePermission 查表时
// 对不上（用户从 UI 存 "bash"，agent 里问的是 "Bash"）。builtin.js 不反向
// 依赖 asapi，不存在循环引用。
import { canonicalToolName } from '../tools/builtin.js';

export const ASAPI_DIR = join(VEGA_DIR, 'asapi');
const AGENTS_PATH = join(ASAPI_DIR, 'agents.json');
const CREDS_PATH = join(ASAPI_DIR, 'credentials.json');
const SESSIONS_DIR = join(ASAPI_DIR, 'sessions');
const RECENTS_PATH = join(ASAPI_DIR, 'workspace-recents.json');
const SKILLS_PATH = join(ASAPI_DIR, 'skills.json');

// ---------- 最近工作目录（工作目录选择器「最近」列表） ----------
const RECENTS_MAX = 8;

/** 记录一次工作目录使用（去重置顶，最多保留 RECENTS_MAX 条）。 */
export function addWorkspaceRecent(dir) {
  if (!dir || typeof dir !== 'string') return;
  const list = listWorkspaceRecents();
  const next = [dir, ...list.filter((d) => d !== dir)].slice(0, RECENTS_MAX);
  writeJson(RECENTS_PATH, next);
}

/** 最近工作目录，最新在前。 */
export function listWorkspaceRecents() {
  const list = readJson(RECENTS_PATH, []);
  return Array.isArray(list) ? list.filter((d) => typeof d === 'string') : [];
}

const now = () => new Date().toISOString();
export const uid = () => randomUUID();

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 损坏 ≠ 不存在：静默当"首次使用"重建会把用户数据直接覆盖丢失
    // （Agent 不存在事故）。隔离留证，人工还有恢复机会。
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* 隔离失败时只能重建 */ }
    console.warn(`[store] ${basename(path)} 解析失败，已隔离为 *.corrupt-* 以便人工恢复`);
    return fallback;
  }
}
function writeJson(path, data) {
  mkdirSync(ASAPI_DIR, { recursive: true });
  // 原子写：先落临时文件再 rename，进程崩溃/强退不会把 JSON 截成半截
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

// ---------- Agents ----------
export function listAgents() {
  let agents = readJson(AGENTS_PATH, null);
  if (!agents) {
    // 首次使用自动创建默认 Agent
    const id = uid();
    agents = [{
      id,
      created_at: now(),
      updated_at: now(),
      user_id: 'local',
      editable: true,
      data: {
        name: 'Corey',
        system_prompt: '', // 空 = 使用 vega 内置紧凑系统提示词
        context_config: { trigger_ratio: 0.8, reserve_ratio: 0.2, tool_result_limit: 6000 },
        react_config: { max_iters: 40, stop_on_reject: true },
        invite_config: { invitable: false, invite_description: null }
      }
    }];
    writeJson(AGENTS_PATH, agents);
  } else {
    // 迁移：历史默认 Agent（名为 Vega 旧代号 / 或 CoCode 旧默认）→ 统一改名 Corey
    let migrated = false;
    for (const a of agents) {
      if (a.user_id === 'local' && (a.data?.name === 'Vega' || a.data?.name === 'CoCode') && !a.data.system_prompt) {
        a.data.name = 'Corey';
        a.updated_at = now();
        migrated = true;
      }
    }
    if (migrated) writeJson(AGENTS_PATH, agents);
  }
  return agents;
}

export function getAgent(id) {
  return listAgents().find((a) => a.id === id) || null;
}

export function createAgent(data) {
  const agents = listAgents();
  const agent = {
    id: uid(), created_at: now(), updated_at: now(), user_id: 'local', editable: true,
    data: {
      name: data.name || 'Agent',
      system_prompt: data.system_prompt || '',
      context_config: { trigger_ratio: 0.8, reserve_ratio: 0.2, tool_result_limit: 6000, ...(data.context_config || {}) },
      react_config: { max_iters: 40, stop_on_reject: true, ...(data.react_config || {}) },
      invite_config: { invitable: false, invite_description: null, ...(data.invite_config || {}) }
    }
  };
  agents.push(agent);
  writeJson(AGENTS_PATH, agents);
  return agent;
}

export function updateAgent(id, patch) {
  const agents = listAgents();
  const i = agents.findIndex((a) => a.id === id);
  if (i < 0) return null;
  const data = { ...agents[i].data };
  for (const k of ['name', 'system_prompt']) if (patch[k] !== undefined) data[k] = patch[k];
  for (const k of ['context_config', 'react_config', 'invite_config']) {
    if (patch[k] !== undefined) data[k] = { ...data[k], ...patch[k] };
  }
  agents[i] = { ...agents[i], data, updated_at: now() };
  writeJson(AGENTS_PATH, agents);
  return agents[i];
}

export function deleteAgent(id) {
  const agents = listAgents().filter((a) => a.id !== id);
  writeJson(AGENTS_PATH, agents);
  // 该 agent 的会话一并删除
  for (const s of listSessionRecords().filter((s) => s.agent_id === id)) deleteSession(s.id);
  return true;
}

// ---------- Credentials（自接入模型：openai_compatible = base_url + api_key）----------
export function listCredentials() {
  return readJson(CREDS_PATH, []);
}

export function createCredential(data) {
  const creds = listCredentials();
  const cred = { id: uid(), created_at: now(), updated_at: now(), user_id: 'local', editable: true, data };
  creds.push(cred);
  writeJson(CREDS_PATH, creds);
  return cred;
}

export function updateCredential(id, data) {
  const creds = listCredentials();
  const i = creds.findIndex((c) => c.id === id);
  if (i < 0) return null;
  creds[i] = { ...creds[i], data: { ...creds[i].data, ...data }, updated_at: now() };
  writeJson(CREDS_PATH, creds);
  return creds[i];
}

export function deleteCredential(id) {
  writeJson(CREDS_PATH, listCredentials().filter((c) => c.id !== id));
  return true;
}

export function getCredential(id) {
  return listCredentials().find((c) => c.id === id) || null;
}

// ---------- Skills（用户已安装的技能库，install 时落盘 SKILL.md）----------
/**
 * SkillView 结构与前端 types.ts 严格对齐：
 *   id, name, enabled, display_name, description, tags, author, icon_url, url,
 *   hub_id, card_id, version, markdown（仅 detail 时设置）
 *
 * markdown 不与 enabled / display_name 等轻量字段混在同一文件 ——
 * 若「详情懒加载」之后引入缓存层，可只写 detail.json；当下落到同一文件
 * 以减少读写。读者用 listSkills() 不返回 markdown，命中一个 null 字段的代价
 * 可忽略（i18n / 列表行不读它）。
 */
function readSkillsDb() {
  const db = readJson(SKILLS_PATH, null);
  if (!db || typeof db !== 'object') return { skills: [] };
  if (!Array.isArray(db.skills)) return { skills: [] };
  return db;
}
function writeSkillsDb(db) {
  writeJson(SKILLS_PATH, db);
}

/** 用 (hub_id + card_id) 查重；同名 name 冲突返回 null 留给上层决定。 */
export function findSkillByCardId(hubId, cardId) {
  return readSkillsDb().skills.find((s) => s.hub_id === hubId && s.card_id === cardId) || null;
}

/** List all installed skills. Returns SkillView[] — markdown stripped for size. */
export function listSkills() {
  return readSkillsDb().skills.map(({ markdown, ...view }) => view);
}

export function getSkill(id) {
  return readSkillsDb().skills.find((s) => s.id === id) || null;
}

/**
 * Install 落盘：把 hub card 转成 SkillView，自动拉一次 detail 拿 markdown（best-effort）。
 * 失败：name 冲突 → 抛 'NAME_CONFLICT'；其他 → 'CONFLICT'。
 *
 * @returns {{ created: boolean, skill: SkillView & { markdown?: string|null } }}
 */
export async function installSkill({ hub_id, card_id, name, display_name, description, description_zh, tags, author, icon_url, url, version, fetchMarkdown }) {
  const db = readSkillsDb();
  const desiredName = name || card_id || 'skill';
  // name 唯一性：同一 hub 内的 name 不冲突；不同 hub 可以重名
  const conflict = db.skills.find((s) => s.name === desiredName);
  if (conflict) {
    const err = new Error('name conflict');
    err.code = 'NAME_CONFLICT';
    err.existing = conflict;
    throw err;
  }

  let markdown = null;
  if (typeof fetchMarkdown === 'function') {
    try { markdown = await fetchMarkdown(); } catch { /* markdown 拉不到不阻塞安装 */ }
  }

  const skill = {
    id: uid(),
    name: desiredName,
    enabled: true,
    display_name: display_name || desiredName,
    description: description || '',
    description_zh: description_zh || null,
    tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
    author: author || null,
    icon_url: icon_url || null,
    url: url || null,
    hub_id,
    card_id,
    version: version || null,
    installed_at: now(),
    markdown,
  };
  db.skills.push(skill);
  writeSkillsDb(db);
  return skill;
}

export function deleteSkill(id) {
  const db = readSkillsDb();
  const before = db.skills.length;
  db.skills = db.skills.filter((s) => s.id !== id);
  if (db.skills.length === before) return false;
  writeSkillsDb(db);
  return true;
}

/**
 * 把已安装 skill 的 markdown 缓存兜底：上层拿到 list 但又要 SKILL.md 时调它。
 * 若已有 markdown 直接返回；若网络不可达返回现有库的（可能为 null）。
 */
export async function loadSkillMarkdown(id, fetcher) {
  const db = readSkillsDb();
  const i = db.skills.findIndex((s) => s.id === id);
  if (i < 0) return null;
  if (db.skills[i].markdown) return db.skills[i].markdown;
  if (typeof fetcher !== 'function') return null;
  try {
    const md = await fetcher();
    if (typeof md === 'string' && md.length > 0) {
      db.skills[i] = { ...db.skills[i], markdown: md };
      writeSkillsDb(db);
    }
    return md;
  } catch {
    return null;
  }
}

/**
 * 本地导入技能：把磁盘上的一个技能文件夹（含 SKILL.md）收进技能库。
 *
 * 路径来自用户在原生对话框里亲手选的目录（Electron 壳层桥），与
 * lspServers 同级信任。SKILL.md 的 YAML frontmatter 做轻量解析
 * （name / display_name / description / version / tags，够用即可，
 * 不引入 yaml 依赖 —— core 零依赖纪律）。
 *
 * 失败：目录不存在 / 没有 SKILL.md / name 冲突，都抛带 code 的 Error。
 */
export function importSkillFromLocal({ path } = {}) {
  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    const err = new Error('需要本地文件夹的绝对路径');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const root = path.replace(/\/+$/, '');
  let stat;
  try { stat = statSync(root); } catch {
    const err = new Error(`目录不存在：${root}`);
    err.code = 'INVALID_PATH';
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`不是一个文件夹：${root}`);
    err.code = 'INVALID_PATH';
    throw err;
  }
  const mdPath = join(root, 'SKILL.md');
  if (!existsSync(mdPath)) {
    const err = new Error('文件夹里没有 SKILL.md —— 这不是有效的技能目录');
    err.code = 'NO_SKILL_MD';
    throw err;
  }
  const raw = readFileSync(mdPath, 'utf8').slice(0, 200_000);

  // 轻量 frontmatter：只认 "---" 围栏里 key: value 的扁平行
  const fm = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
      if (kv) fm[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '');
    }
  }

  const base = basename(root);
  const rawName = (fm.name || base).trim().replace(/\s+/g, '-');
  const name = rawName.replace(/[^\w.-]/g, '-').slice(0, 64) || base;
  const db = readSkillsDb();
  const conflict = db.skills.find((sk) => sk.name === name);
  if (conflict) {
    const err = new Error('name conflict');
    err.code = 'NAME_CONFLICT';
    err.existing = conflict;
    throw err;
  }

  const tags = (fm.tags ? String(fm.tags).split(/[,，\s]+/).filter(Boolean) : []).slice(0, 8);
  const skill = {
    id: uid(),
    name,
    enabled: true,
    display_name: fm.display_name || fm.name || base,
    description: fm.description || '',
    description_zh: null,
    tags: tags.length ? tags : ['local'],
    author: fm.author || null,
    icon_url: null,
    url: null,
    hub_id: 'local',
    card_id: base,
    version: fm.version || null,
    installed_at: now(),
    markdown: raw,
  };
  db.skills.push(skill);
  writeSkillsDb(db);
  const { markdown, ...view } = skill;
  return view;
}

/** 全清（admin/reset 调用）。 */
export function resetSkills() {
  writeJson(SKILLS_PATH, { skills: [] });
  return { skills_cleared: true };
}

// ---------- Sessions ----------
function sessionPath(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('非法会话 ID');
  return join(SESSIONS_DIR, `${id}.json`);
}

export function defaultModelConfig(cfg) {
  return {
    type: 'openai_compatible',
    credential_id: '', // 空 = 直接用 ~/.vega/config.json（CLI 同源配置）
    model: cfg.model,
    parameters: {}
  };
}

export function createSessionRecord({ agent_id, chat_model_config, fallback_chat_model_config, vegaCfg, workspace_id, cwd, origin, team_id }) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const id = uid();
  const t = now();
  const record = {
    id, created_at: t, updated_at: t, user_id: 'local',
    agent_id,
    origin: origin || { type: 'user' },
    team_id: team_id || null,
    config: {
      name: '',
      naming: { auto: true },
      chat_model_config: chat_model_config || defaultModelConfig(vegaCfg),
      fallback_chat_model_config: fallback_chat_model_config || null,
      tts_model_config: null,
      knowledge_config: null,
      workspace_id: workspace_id || 'default',
      cwd: cwd || null,
    },
    // 权限模式默认 default（写/执行会弹确认卡片）。
    // 之所以历史上是 bypass：当初 HITL 还没落地，default 会被当成 deny 用，
    // 于是干脆默认放行。现在确认卡片链路已经打通，default 才是合理默认值
    // —— 用户在模式选择器里随时可以放宽到 accept_edits / bypass。
    state: { permission_mode: 'default' },
    // vega 内部：OpenAI 格式消息（供 runAgent），display 为 agentscope Msg[]
    internal: [],
    display: []
  };
  writeJson(sessionPath(id), record);
  return record;
}

export function listSessionRecords() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

export function loadSessionRecord(id) {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function saveSessionRecord(record) {
  record.updated_at = now();
  writeJson(sessionPath(record.id), record);
  return record;
}

export function deleteSession(id) {
  const p = sessionPath(id);
  if (existsSync(p)) unlinkSync(p);
  return true;
}

// ---------- 会话检索 / 分支 / 导出 ----------
//
// 会话原本是 ~/.vega/asapi/sessions/*.json 平铺文件：没有索引、不能搜索、
// 不能从某一轮 fork 重来。这里补上最小可用的三件事（零依赖，直接扫目录；
// 单个用户几十~几百个会话的量级下，扫描比维护索引更省事也更不容易不一致）。

const displayTextOf = (record) =>
  (record.display || [])
    .map((m) => (Array.isArray(m.content)
      ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      : String(m.content ?? '')))
    .join('\n');

/**
 * 全文搜索会话。
 * @param {string} q 关键词（不区分大小写；多个词按 AND 匹配）
 * @param {{agent_id?:string, limit?:number}} [opts]
 */
export function searchSessions(q, { agent_id, limit = 50 } = {}) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const rec of listSessionRecords()) {
    if (agent_id && rec.agent_id !== agent_id) continue;
    const hay = `${rec.config?.name || ''}\n${displayTextOf(rec)}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    // 摘一段命中上下文，方便前端直接展示
    const text = displayTextOf(rec);
    const first = terms[0];
    const at = text.toLowerCase().indexOf(first);
    out.push({
      id: rec.id,
      agent_id: rec.agent_id,
      name: rec.config?.name || '(未命名)',
      updated_at: rec.updated_at,
      message_count: (rec.display || []).length,
      snippet: at >= 0 ? text.slice(Math.max(0, at - 40), at + 120).replace(/\s+/g, ' ') : ''
    });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

/**
 * 从某一轮 fork 出新会话。
 * @param {string} id 源会话
 * @param {{upto?:number, name?:string}} [opts]
 *   upto = 保留 display 的前 N 条消息（一个"轮"≈ user + assistant 两条）。
 *          缺省 = 原样全量复制（等于"另存为"）。
 * @returns {{id:string}|null}
 */
export function forkSession(id, { upto, name } = {}) {
  const src = loadSessionRecord(id);
  if (!src) return null;
  const display = Array.isArray(src.display) ? src.display : [];
  const internal = Array.isArray(src.internal) ? src.internal : [];
  const keep = Number.isFinite(upto) ? Math.max(0, Math.min(upto, display.length)) : display.length;

  // internal 与 display 不是一一对应（隐式上下文、压缩都会错位），所以按
  // "保留最后 N 条 assistant 回复之后的边界"来截断内部历史：从 display 里
  // 找出被保留的最后一条 assistant 的文本，在 internal 里定位到它就截断。
  let internalEnd = internal.length;
  if (keep < display.length) {
    const lastKept = [...display.slice(0, keep)].reverse().find((m) => m.role === 'assistant');
    const marker = lastKept ? displayTextOf({ display: [lastKept] }).trim().slice(0, 60) : '';
    if (marker) {
      for (let i = internal.length - 1; i >= 0; i--) {
        if (String(internal[i].content ?? '').includes(marker)) { internalEnd = i + 1; break; }
      }
    } else {
      internalEnd = 0;
    }
  }

  const record = createSessionRecord({
    agent_id: src.agent_id,
    chat_model_config: src.config?.chat_model_config || null,
    fallback_chat_model_config: src.config?.fallback_chat_model_config || null,
    vegaCfg: loadConfig(),
    cwd: src.config?.cwd || null,
  });
  record.config.name = name || `${src.config?.name || '会话'}（分支）`;
  record.config.naming = { auto: false };
  record.state = { ...(src.state || {}) };
  record.display = display.slice(0, keep).map((m) => JSON.parse(JSON.stringify(m)));
  record.internal = internal.slice(0, internalEnd).map((m) => JSON.parse(JSON.stringify(m)));
  saveSessionRecord(record);
  return { id: record.id, name: record.config.name, messages: record.display.length };
}

/** 导出会话为 markdown 或 json */
export function exportSession(id, format = 'md') {
  const rec = loadSessionRecord(id);
  if (!rec) return null;
  if (format === 'json') return { format: 'json', body: JSON.stringify(rec, null, 2) };
  const lines = [
    `# ${rec.config?.name || '会话'}`,
    '',
    `- 会话 ID: \`${rec.id}\``,
    `- 创建: ${rec.created_at}`,
    `- 更新: ${rec.updated_at}`,
    `- 工作目录: ${rec.config?.cwd || '(未设置)'}`,
    `- 权限模式: ${rec.state?.permission_mode || rec.state?.permission_context?.mode || '(默认)'}`,
    '',
    '---',
    ''
  ];
  for (const m of rec.display || []) {
    const who = m.role === 'user' ? '## 用户' : '## 助手';
    lines.push(who, '');
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'text') lines.push(b.text, '');
      else if (b.type === 'tool_call') lines.push('```tool_call', `${b.name} ${b.input || ''}`.slice(0, 2000), '```', '');
      else if (b.type === 'tool_result') {
        const t = Array.isArray(b.output)
          ? b.output.filter((o) => o.type === 'text').map((o) => o.text).join('\n')
          : String(b.output ?? '');
        lines.push(`<details><summary>工具结果 ${b.name || ''} (${b.state})</summary>`, '', '```', t.slice(0, 4000), '```', '', '</details>', '');
      }
    }
  }
  return { format: 'md', body: lines.join('\n') };
}

// ---------- 权限规则（允许清单）----------
// ConfirmCard 的 suggested_rules 结构 → 落盘到 ~/.vega/config.json 的
// permissionRules，由 agent.js 的 decidePermission 查表。这样"这条命令以后
// 都别问我"才是真的持久有效，而不是只在当前这一轮的内存里。

export function listPermissionRules() {
  const list = loadConfig().permissionRules;
  return Array.isArray(list) ? list : [];
}

export function addPermissionRule(rule) {
  if (!rule || typeof rule !== 'object' || !rule.tool_name) return null;
  const clean = {
    tool_name: canonicalToolName(rule.tool_name),
    rule_content: rule.rule_content == null ? null : String(rule.rule_content),
    behavior: ['allow', 'deny', 'ask'].includes(rule.behavior) ? rule.behavior : 'allow',
    source: rule.source || 'userSettings'
  };
  if (!clean.tool_name) return null;
  const list = listPermissionRules();
  const dup = list.findIndex((r) => r.tool_name === clean.tool_name
    && (r.rule_content ?? null) === clean.rule_content && r.behavior === clean.behavior);
  if (dup >= 0) return list[dup];
  list.push(clean);
  saveConfig({ permissionRules: list });
  return clean;
}

/** 按下标或精确匹配删除规则 */
export function deletePermissionRule({ index, rule }) {
  const list = listPermissionRules();
  let idx = -1;
  if (Number.isFinite(index)) idx = index;
  else if (rule) {
    const want = canonicalToolName(rule.tool_name);
    idx = list.findIndex((r) => r.tool_name === want
      && (r.rule_content ?? null) === (rule.rule_content ?? null)
      && r.behavior === (rule.behavior || 'allow'));
  }
  if (idx < 0 || idx >= list.length) return false;
  list.splice(idx, 1);
  saveConfig({ permissionRules: list });
  return true;
}

export function clearPermissionRules() {
  saveConfig({ permissionRules: [] });
  return true;
}

/**
 * 清空全部数据（会话 + 凭证 + Agent 重置回默认）。
 * 供设置窗口的"清空所有数据"使用。
 * @returns {{sessions:number, credentials:number, agents:number}} 删除计数
 */export function resetAll() {
  const sessions = listSessionRecords().length;
  if (existsSync(SESSIONS_DIR)) {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (f.endsWith('.json')) { try { unlinkSync(join(SESSIONS_DIR, f)); } catch { /* 忽略单个失败 */ } }
    }
  }
  const credentials = listCredentials().length;
  if (existsSync(CREDS_PATH)) { try { unlinkSync(CREDS_PATH); } catch { /* 忽略 */ } }
  const agents = listAgents().length;
  if (existsSync(AGENTS_PATH)) { try { unlinkSync(AGENTS_PATH); } catch { /* 忽略 */ } }
  // 下次 listAgents() 会自动重建默认 Agent
  listAgents();
  // Skills 库同样清掉
  const skills = listSkills().length;
  if (existsSync(SKILLS_PATH)) { try { unlinkSync(SKILLS_PATH); } catch { /* 忽略 */ } }
  return { sessions, credentials, agents, skills };
}
