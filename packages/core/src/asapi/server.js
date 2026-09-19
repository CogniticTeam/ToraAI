// ASAPI HTTP 服务（多模型列表 + SPA fallback 全量改造版本）
// - 完整实现：/health /agent /sessions(/messages /stream /interrupt) /chat /credential /model /workspace
// - 空态 stub：/channels /hub /skill /mcp /knowledge_bases（对应页面显示空列表）
// - 定时任务：/schedule CRUD + /schedule/:id/sessions（见 asapi/schedules.js）
// - CoCode 扩展：/admin/reset /admin/config /admin/workspace-recents /admin/models /admin/models-config
// - 静态托管 desktop/frontend/dist（SPA fallback 收紧到页面导航）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { loadConfig, saveConfig, syncEffectiveModel, DEFAULT_CONFIG } from '../config.js';
import {
  listAgents, getAgent, createAgent, updateAgent, deleteAgent,
  listCredentials, createCredential, updateCredential, deleteCredential,
  createSessionRecord, listSessionRecords, loadSessionRecord, saveSessionRecord, deleteSession,
  addWorkspaceRecent, listWorkspaceRecents,
  listSkills, getSkill, findSkillByCardId, installSkill, deleteSkill, loadSkillMarkdown, importSkillFromLocal,
  searchSessions, forkSession, exportSession,
  listPermissionRules, addPermissionRule, deletePermissionRule, clearPermissionRules,
  resetAll
} from './store.js';
import { HubError } from './hub-error.js';
import { HUBS, providerFor } from './hubs.js';
import { toSessionView, inputToText, systemNoticeMsg } from './protocol.js';
import { startChatRun, isRunning, subscribe, interrupt, resolveConfirm, resolveQuestion, isAwaitingConfirm, loadExtraTools } from './bridge.js';
import { readGitInfo, runGit } from '../tools/git.js';
import { realpathAllowMissing } from '../security.js';
import { listMemories, saveMemory, updateMemory, deleteMemory, searchMemories, loadMemoryConfig, saveMemoryConfig, MemoryValidationError } from './memory.js';
import { discoverLocalModels } from '../discover.js';
import { loadCommands } from '../commands.js';
import { detectVision } from '../model.js';
import { describeHooks, HOOK_EVENTS } from '../hooks.js';
import { listTraces, readTrace, renderTrace, gcTraces, traceStats } from '../trace.js';
import { usageStats } from './usage.js';
import { PLAN_DEFS, getPlanDef } from '../plans.js';
import { buildSymbolIndex } from '../tools/lsp.js';
import { normalizeMcpServers, mcpStatus } from '../tools/mcp.js';
import { listServers as mcpListServers, addServer as mcpAddServer, updateServer as mcpUpdateServer, removeServer as mcpRemoveServer, probeServer as mcpProbeServer, callTool as mcpCallTool, listTemplates as mcpListTemplates } from '../tools/mcp-workshop.js';
import { createTerminal, writeTerminal, killTerminal, getTerminal, subscribeTerminal, replayTerminal } from './terminal.js';
import { listCheckpoints, restore as restoreCheckpoint, clearCheckpoints } from '../tools/checkpoint.js';
import { listBranches, createBranch, switchBranch, deleteBranch, listWorktrees, createWorktree, removeWorktree, stageFiles, unstageFiles, statusFiles, commit, log as gitLog } from '../tools/cocode-git.js';
import { listAutomations, createAutomation, updateAutomation, deleteAutomation, drainNotifications } from '../tools/automations.js';
import {
  listTeams as listTeamsStore, getTeam as getTeamStore, createTeam as createTeamStore,
  updateTeam as updateTeamStore, disbandTeam as disbandTeamStore, getTeamDocPath
} from './team-store.js';
import { buildSemanticIndex, indexStats } from '../tools/semantic.js';
import {
  listSchedules, createSchedule, updateSchedule, deleteSchedule,
  listRuns, validateCron, startScheduler, setScheduleFireHandler,
} from './schedules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 找可执行文件（避免为「探测一下有没有装」去 spawn 子进程）。
 *
 * 除了 PATH，还要看几个「装了但不在 PATH 上」的高频位置 —— 尤其是
 * 托管 node 的 workspace/.bin（本环境用 npm install 装东西的落点）。
 * 少了这一步，探测结果会是「没装」，而用户明明刚装好。
 */
const EXTRA_BIN_DIRS = () => [
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'Library', 'pnpm'),
  join(homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  // 托管运行时的工作区（COCODE_NODE_WORKSPACE 可覆盖）
  process.env.COCODE_NODE_WORKSPACE
    ? join(process.env.COCODE_NODE_WORKSPACE, 'node_modules', '.bin')
    : join(homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', '.bin')
];

function whichSync(cmd) {
  const dirs = [
    ...(process.env.PATH || '').split(':').filter(Boolean),
    ...EXTRA_BIN_DIRS()
  ];
  for (const dir of dirs) {
    const p = join(dir, cmd);
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch { /* 继续找 */ }
  }
  return null;
}

/**
 * 在 language server 自己的 node_modules 里找 typescript 的 tsserver.js。
 * 之所以要"从 server 往上找"：装了 server 的机器通常同一层也装了 typescript，
 * 而被打开的项目里没有 —— 这个路径正好补上那个缺口。
 */
function findTsserverNear(serverBin) {
  if (!serverBin) return null;
  const candidates = [
    join(dirname(dirname(serverBin)), 'typescript', 'lib', 'tsserver.js'), // .bin/xx → node_modules/typescript/...
    join(dirname(serverBin), 'typescript', 'lib', 'tsserver.js')
  ];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch { /* 继续找 */ }
  }
  return null;
}

/** 符号索引的规模（不重建，只读缓存文件大小） */
function loadSymbolIndexStats(cwd) {
  try {
    const idx = buildSymbolIndex(cwd, { force: false });
    return { files: idx.files, count: idx.symbols.length, reason: idx.reason || null };
  } catch (e) { return { error: e?.message || String(e) }; }
}
const DIST_DIR = join(__dirname, '..', '..', '..', 'desktop', 'frontend', 'dist');

/**
 * 会返回 JSON 的路径前缀。没进这张表的 GET 会落到静态托管（返回 index.html）。
 * 加新端点时务必同步这里 —— 否则前端拿到 HTML 去 JSON.parse，
 * 报错是 "Unexpected token '<', "<!doctype "... is not valid JSON"，很难倒查到路由。
 */
const API_PREFIXES = [
  '/agent', '/sessions', '/chat', '/credential', '/model', '/workspace',
  '/schedule', '/channels', '/hub', '/skill', '/mcp', '/mcp-workshop', '/knowledge',
  '/health', '/tts-model', '/embedding-model', '/permission', '/commands',
  '/tools', '/traces', '/hooks', '/admin', '/memories', '/memory-config', '/terminal', '/git', '/automations', '/notifications',
  '/teams',
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8'
};

const AGENT_SCHEMA = {
  schema: {
    title: 'AgentData', type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', description: '显示在会话侧栏与选择器中' },
      system_prompt: {
        type: 'string', format: 'textarea', title: 'System Prompt',
        description: '留空则使用 CoCode 内置紧凑提示词（低 token）'
      },
      context_config: {
        type: 'object', title: 'Context Config',
        properties: {
          trigger_ratio: { type: 'number', title: 'Trigger Ratio', minimum: 0, maximum: 1, default: 0.8 },
          reserve_ratio: { type: 'number', title: 'Reserve Ratio', minimum: 0, maximum: 1, default: 0.2 },
          tool_result_limit: { type: 'integer', title: 'Tool Result Limit', minimum: 500, maximum: 50000, default: 6000 }
        }
      },
      react_config: {
        type: 'object', title: 'ReAct Config',
        properties: {
          max_iters: { type: 'integer', title: 'Max Iters', minimum: 1, maximum: 200, default: 40 },
          stop_on_reject: { type: 'boolean', title: 'Stop On Reject', default: true }
        }
      },
      invite_config: {
        type: 'object', title: 'Invite Config',
        properties: {
          invitable: { type: 'boolean', title: 'Invitable', default: false },
          invite_description: { type: ['string', 'null'], format: 'textarea', title: 'Invite Description' }
        }
      }
    },
    required: ['name']
  }
};

const CREDENTIAL_SCHEMAS = {
  schemas: [
    {
      title: 'OpenAI 兼容接口（自接入模型）',
      type: 'object',
      properties: {
        type: { type: 'string', const: 'openai_compatible', title: 'Type' },
        name: { type: 'string', title: '名称', description: '如 DeepSeek / 智谱 / 本地 Ollama' },
        base_url: { type: 'string', title: 'Base URL', description: '如 https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1' },
        api_key: { type: 'string', title: 'API Key', writeOnly: true, description: '本地模型可留空' }
      },
      required: ['type', 'name', 'base_url']
    }
  ]
};

function json(res, code, data) {
  // CORS：本机 dev server（Vite 等任意端口）直连调试用。Origin 校验已由
  // isLoopbackOrigin 把关，这里回显合法 loopback 来源即可。
  const origin = res.req?.headers?.origin;
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (origin && isLoopbackOrigin({ headers: { origin } })) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(data));
}
function apiError(res, code, detail) {
  return json(res, code, { detail });
}

async function readBody(req) {
  let buf = '';
  for await (const c of req) buf += c;
  if (!buf) return {};
  try { return JSON.parse(buf); } catch { throw new Error('请求体不是合法 JSON'); }
}

// ---------- 多模型列表辅助 ----------
// 把 ~/.vega/config.json 的 modelList 合成为 "cocode-models" 凭证，
// 让添加的模型出现在前端 LlmSelect 里。bridge.js 选中 "cocode-models" 时按 model 名查 cfg.modelList。
const COCODE_CRED_ID = 'cocode-models';

function enabledModels(cfg) {
  return (Array.isArray(cfg.modelList) ? cfg.modelList : []).filter((m) => m.enabled && m.model);
}

function cocodeCredential(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const models = enabledModels(cfg);
  return {
    id: COCODE_CRED_ID, user_id: 'local', editable: false,
    created_at: now, updated_at: now,
    data: {
      type: 'openai_compatible', name: 'CoCode 模型', source: 'models-config',
      base_url: models[0]?.baseURL || '', api_key: '', model: '',
      // 前端 LlmSelect 要按模型显示服务商品牌图标。这个合成凭证把一批不同
      // 服务商的模型混在一起，单靠 data.provider 分辨不出来，所以单独给一份
      // "模型名 → provider key" 的映射（未列出的回退成通用图标）。
      model_providers: Object.fromEntries(
        models.map((m) => [m.model, m.provider || 'custom']),
      ),
      // 官方模型名列表：LlmSelect 据此在模型名旁渲染「官方」徽标，
      // 与用户自配模型区分。isOfficial 字段来自云端 user_models.is_official。
      official_models: models.filter((m) => m.isOfficial).map((m) => m.model),
      // 官方模型名 → 积分档位：LlmSelect 据此在徽标上标注消耗档位
      // （tier 由云端 /models 按倍率表解析，未知时回退 standard）。
      official_tiers: Object.fromEntries(
        models.filter((m) => m.isOfficial).map((m) => [m.model, m.tier || 'standard']),
      ),
    }
  };
}

// ---------- Origin / Host 校验（防跨域访问与 DNS rebinding） ----------
// 本地 ASAPI 监听 127.0.0.1，但浏览器内嵌网页或恶意页面仍可能向本机端口发请求。
// 管理端点（/admin/*）可清空数据、改配置，必须严格限制来源。
function isLoopbackOrigin(req) {
  const origin = req.headers['origin'];
  // 无 Origin（同源请求、CLI/curl）或 null（file:// 页面）放行
  if (!origin || origin === 'null') return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin.startsWith('file://');
}
function isLoopbackHost(req) {
  const host = String(req.headers['host'] || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '';
}

export function startASAPIServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    try { await route(req, res); }
    catch (e) { apiError(res, 500, e?.message || String(e)); }
  });
  // 定时任务到点：建一个归属该 agent 的会话，用任务描述当首条消息跑一轮。
  // 无人值守，权限模式取任务配置（默认 dont_ask），失败由调度器记入执行历史。
  setScheduleFireHandler((sched) => {
    const agent = getAgent(sched.agent_id);
    if (!agent) throw new Error('agent 不存在');
    const record = createSessionRecord({
      agent_id: sched.agent_id,
      chat_model_config: sched.data?.chat_model_config || null,
      fallback_chat_model_config: null,
      vegaCfg: loadConfig(),
      cwd: null,
    });
    record.state.permission_mode = sched.data?.permission_mode || 'dont_ask';
    saveSessionRecord(record);
    startChatRun(record.id, agent, { userText: sched.data?.description || sched.data?.name || '' });
    return record.id;
  });
  return new Promise((resolve, reject) => {
    // listen 失败（如固定端口被占）必须 reject，否则 Promise 永远挂起，
    // 调用方连降级重试的机会都没有。
    server.once('error', reject);
    server.listen(port, host, () => {
      startScheduler(); // 幂等单例；interval 已 unref
      resolve(server);
    });
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;
  const q = Object.fromEntries(url.searchParams);

  // ---------- CORS 预检 ----------
  // 浏览器 dev 环境跨端口调试：预检直接放行合法 loopback 来源。
  if (method === 'OPTIONS') {
    const origin = req.headers['origin'];
    if (origin && isLoopbackOrigin(req)) {
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-user-id',
        'access-control-max-age': '86400',
        vary: 'Origin',
      });
      res.end();
      return;
    }
  }

  // ---------- 来源校验 ----------
  // API 前缀请求校验 Origin 是 loopback/file（防嵌入网页跨域打本地端口）；
  // 管理端点额外校验 Host 必须是 127.0.0.1/localhost（防 DNS rebinding）。
  if (API_PREFIXES.some((pre) => p.startsWith(pre)) && !isLoopbackOrigin(req)) {
    return apiError(res, 403, 'Forbidden: origin not allowed');
  }
  if (p.startsWith('/admin/') && !isLoopbackHost(req)) {
    return apiError(res, 403, 'Forbidden: admin endpoints require loopback host');
  }

  // ---------- 静态前端 ----------
  // 带文件扩展名的 GET（favicon、资源文件）优先走静态，避免 /agent 等前缀误吞
  if (method === 'GET' && /\.[a-zA-Z0-9]+$/.test(p)) {
    return serveStatic(p, res);
  }
  // 无扩展名的 GET：API 前缀走路由，其余当 SPA 路由丢给静态托管。
  // 注意：这张表必须覆盖**所有** API 前缀 —— 漏一个就会被 serveStatic 吃掉并
  // 返回 index.html，前端拿到 HTML 去 JSON.parse，症状是莫名其妙的
  // "Unexpected token '<'，<!doctype ... is not valid JSON"。
  if (method === 'GET' && !API_PREFIXES.some((pre) => p.startsWith(pre))) {
    return serveStatic(p, res);
  }

  if (p === '/health' && method === 'GET') {
    return json(res, 200, { status: 'ok', version: '0.1.0', components: {} });
  }

  // ---------- 管理端点（CoCode 扩展，非 agentscope 协议） ----------
  // 设置窗口的"清空所有数据"
  if (p === '/admin/reset' && method === 'POST') {
    const counts = resetAll();
    return json(res, 200, { status: 'ok', ...counts });
  }

  // 使用统计（设置窗口「使用统计」板块）：聚合 traces 的 token/工具/时长
  // 与 sessions 的创建/更新时间，纯读操作。
  if (p === '/admin/usage-stats' && method === 'GET') {
    return json(res, 200, usageStats());
  }

  // 读取生效 baseURL/model/apiKey 不回明文
  if (p === '/admin/config' && method === 'GET') {
    const cfg = loadConfig();
    return json(res, 200, { baseURL: cfg.baseURL, model: cfg.model, apiKeySet: !!cfg.apiKey });
  }
  // 写入：apiKey 空字符串/缺省 = 保留原值
  if (p === '/admin/config' && method === 'POST') {
    try {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.baseURL === 'string' && body.baseURL.trim()) patch.baseURL = body.baseURL.trim().replace(/\/+$/, '');
      if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
      const next = saveConfig(patch);
      return json(res, 200, { status: 'ok', baseURL: next.baseURL, model: next.model, apiKeySet: !!next.apiKey });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }
  // Agent 运行行为（上下文压缩/工具输出/迭代轮数）：与 /admin/config 物理隔离，
  // 防止设置窗口误把 baseURL/apiKey 之外的东西写入连接配置。
  if (p === '/admin/runtime' && method === 'GET') {
    const cfg = loadConfig();
    return json(res, 200, {
      maxTokensBudget: cfg.maxTokensBudget,
      toolOutputLimit: cfg.toolOutputLimit,
      maxTurns: cfg.maxTurns,
      persistentShell: cfg.persistentShell !== false,
      injectProjectContext: cfg.injectProjectContext !== false,
      repoMapInject: cfg.repoMapInject !== false,
      checkpointEnabled: cfg.checkpointEnabled !== false,
      vision: cfg.vision ?? null,
      allowedRoots: cfg.allowedRoots || [],
      hooksEnabled: cfg.hooksEnabled !== false,
      trustProjectHooks: cfg.trustProjectHooks === true,
      trustProjectHooksFor: cfg.trustProjectHooksFor || [],
      traceEnabled: cfg.traceEnabled !== false,
      traceFullBody: cfg.traceFullBody === true,
      changesAware: cfg.changesAware !== false,
      changesLimit: cfg.changesLimit ?? 12,
      lspServers: cfg.lspServers || {},
      mcpServers: normalizeMcpServers(cfg.mcpServers)
    });
  }
  if (p === '/admin/runtime' && method === 'POST') {
    try {
      const body = await readBody(req);
      const patch = {};
      // 数值字段：缺省/非法用 type=number 判定，限定合法区间防误输入
      const int = (v, min, max, fallback) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, Math.round(n)));
      };
      if (body.maxTokensBudget !== undefined) {
        patch.maxTokensBudget = int(body.maxTokensBudget, 2000, 200000, DEFAULT_CONFIG.maxTokensBudget);
      }
      if (body.toolOutputLimit !== undefined) {
        patch.toolOutputLimit = int(body.toolOutputLimit, 200, 50000, DEFAULT_CONFIG.toolOutputLimit);
      }
      if (body.maxTurns !== undefined) {
        patch.maxTurns = int(body.maxTurns, 1, 200, DEFAULT_CONFIG.maxTurns);
      }
      // 行为开关（布尔）
      for (const k of [
        'persistentShell', 'injectProjectContext', 'repoMapInject', 'checkpointEnabled',
        'hooksEnabled', 'trustProjectHooks', 'traceEnabled', 'traceFullBody', 'changesAware'
      ]) {
        if (typeof body[k] === 'boolean') patch[k] = body[k];
      }
      if (body.changesLimit !== undefined) patch.changesLimit = int(body.changesLimit, 0, 50, DEFAULT_CONFIG.changesLimit);
      if (Array.isArray(body.trustProjectHooksFor)) {
        patch.trustProjectHooksFor = body.trustProjectHooksFor
          .filter((p) => typeof p === 'string' && p.startsWith('/')).slice(0, 50);
      }
      if (body.mcpServers !== undefined) {
        // 与 lspServers 同级信任（用户自己的配置），但结构收紧：
        // 键做工具名安全字符，command 必须是非空字符串
        patch.mcpServers = normalizeMcpServers(body.mcpServers);
      }
      if (body.lspServers && typeof body.lspServers === 'object' && !Array.isArray(body.lspServers)) {
        const clean = {};
        for (const [ext, v] of Object.entries(body.lspServers).slice(0, 20)) {
          if (!ext.startsWith('.')) continue;
          if (typeof v === 'string') { clean[ext] = { command: v, args: [] }; continue; }
          if (!v || typeof v.command !== 'string') continue;
          const srv = { command: v.command, args: Array.isArray(v.args) ? v.args.slice(0, 10).map(String) : [] };
          // initializationOptions / env 必须透传：typescript-language-server 拿不到
          // tsserver.path 会直接退出，而"一键启用"写进去的正是这个 —— 只放行
          // command/args 会让按钮看起来生效、实际用不了。
          if (v.initializationOptions && typeof v.initializationOptions === 'object') {
            const json = JSON.stringify(v.initializationOptions);
            if (json.length <= 8000) srv.initializationOptions = JSON.parse(json);
          }
          if (v.env && typeof v.env === 'object' && !Array.isArray(v.env)) {
            srv.env = Object.fromEntries(Object.entries(v.env).slice(0, 20).map(([k, val]) => [String(k), String(val)]));
          }
          clean[ext] = srv;
        }
        patch.lspServers = clean;
      }
      // vision: null=自动，true/false 强制
      if (body.vision === null || typeof body.vision === 'boolean') patch.vision = body.vision;
      // allowedRoots：只接受绝对路径数组（沙箱的显式放行目录）
      if (Array.isArray(body.allowedRoots)) {
        patch.allowedRoots = body.allowedRoots
          .filter((p) => typeof p === 'string' && p.startsWith('/'))
          .slice(0, 20);
      }
      if (!Object.keys(patch).length) {
        return apiError(res, 400, '没有可识别的 runtime 字段');
      }
      const next = saveConfig(patch);
      return json(res, 200, {
        status: 'ok',
        maxTokensBudget: next.maxTokensBudget,
        toolOutputLimit: next.toolOutputLimit,
        maxTurns: next.maxTurns,
        persistentShell: next.persistentShell !== false,
        injectProjectContext: next.injectProjectContext !== false,
        repoMapInject: next.repoMapInject !== false,
        checkpointEnabled: next.checkpointEnabled !== false,
        vision: next.vision ?? null,
        allowedRoots: next.allowedRoots || [],
        hooksEnabled: next.hooksEnabled !== false,
        trustProjectHooks: next.trustProjectHooks === true,
        trustProjectHooksFor: next.trustProjectHooksFor || [],
        traceEnabled: next.traceEnabled !== false,
        traceFullBody: next.traceFullBody === true,
        changesAware: next.changesAware !== false,
        changesLimit: next.changesLimit ?? 12,
        lspServers: next.lspServers || {}
      });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }
  // 把某个目录初始化为 git 仓库（首次用 git 工具/变更预览前的必要一步）
  if (p === '/admin/git-init' && method === 'POST') {
    try {
      const body = await readBody(req);
      const cwd = body?.cwd
        || (body?.session_id ? loadSessionRecord(body.session_id)?.config?.cwd : null);
      if (!cwd) return apiError(res, 422, '需要 cwd 或带工作目录的 session_id');
      const root = realpathAllowMissing(cwd);
      const info = await readGitInfo(root);
      if (info.is_repo) return json(res, 200, { status: 'ok', already: true, git: info });
      const r = await runGit(['init'], root);
      if (!r.ok) return apiError(res, 500, (r.stderr || 'git init 失败').trim());
      return json(res, 200, { status: 'ok', already: false, git: await readGitInfo(root) });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }
  if (p === '/admin/workspace-recents' && method === 'GET') {
    return json(res, 200, { recents: listWorkspaceRecents() });
  }
  /**
   * "现在该用哪个工作目录" —— 给设置页用（它不属于任何会话）。
   *
   * 为什么不让前端自己拼：候选来源有两个（最近工作目录 → 最近有目录的会话），
   * 而且都得过 realpath 归一化，否则 /var 与 /private/var 会让"刚信任又失效"。
   * 这些知识属于后端，前端只该问一句"是哪个目录"。
   */
  if (p === '/admin/current-workspace' && method === 'GET') {
    const recents = listWorkspaceRecents();
    if (recents.length) {
      return json(res, 200, { cwd: realpathAllowMissing(recents[0]), source: 'recent', alternatives: recents.slice(0, 8) });
    }
    const withCwd = listSessionRecords().find((r) => r?.config?.cwd);
    if (withCwd) {
      return json(res, 200, { cwd: realpathAllowMissing(withCwd.config.cwd), source: 'session', alternatives: [] });
    }
    return json(res, 200, { cwd: null, source: null, alternatives: [] });
  }
  // 本地模型自动发现：扫 Ollama / LM Studio / vLLM 等默认端口，填配置一键可用
  if (p === '/admin/local-models' && method === 'GET') {
    try {
      const found = await discoverLocalModels({ timeout: Number(q.timeout) || 800 });
      return json(res, 200, { providers: found, total: found.length });
    } catch (e) { return apiError(res, 502, `探测本地模型失败: ${e?.message || e}`); }
  }
  // 自定义斜杠命令（提示词模板）：/review、/commit-msg 这类
  if (p === '/commands' && method === 'GET') {
    const cwd = q.session_id ? (loadSessionRecord(q.session_id)?.config?.cwd || null) : null;
    return json(res, 200, loadCommands(cwd));
  }
  // 额外工具（项目级 / 用户级）：让前端也能看到"哪些自定义工具被加载了"
  if (p === '/tools/extra' && method === 'GET') {
    const cwd = q.session_id ? (loadSessionRecord(q.session_id)?.config?.cwd || null) : null;
    try {
      const tools = await loadExtraTools(cwd || null);
      return json(res, 200, tools.map((t) => ({ name: t.name, description: t.description || '' })));
    } catch (e) { return apiError(res, 500, e?.message || String(e)); }
  }

  // ---------- 可观测性：trace / 回放 ----------
  // trace 是排障入口：用户说「它瞎改了一通」时，先看 trace 里第几轮上下文被压掉了。
  if (p === '/traces' && method === 'GET') {
    const traces = listTraces({ sessionId: q.session_id || null, limit: Number(q.limit) || 50 });
    return json(res, 200, { traces, total: traces.length, stats: traceStats() });
  }
  if (p === '/traces' && method === 'DELETE') {
    return json(res, 200, { status: 'ok', ...gcTraces({ keepDays: Number(q.keep_days) || 7 }) });
  }
  if (p.startsWith('/traces/') && method === 'GET') {
    const rest = decodeURIComponent(p.slice('/traces/'.length));
    if (rest.endsWith('/events')) {
      const t = readTrace(rest.slice(0, -'/events'.length));
      if (!t) return apiError(res, 404, 'trace 不存在');
      return json(res, 200, { id: t.id, lines: t.lines });
    }
    if (rest.endsWith('/markdown')) {
      const md = renderTrace(rest.slice(0, -'/markdown'.length));
      return json(res, 200, { markdown: md });
    }
    const t = readTrace(rest);
    if (!t) return apiError(res, 404, 'trace 不存在');
    // 回放需要的原始事件流（前端可以按顺序重演一遍）
    return json(res, 200, {
      id: t.id,
      start: t.start, end: t.end,
      turns: t.turns, tools: t.tools, events: t.events, hooks: t.hooks
    });
  }

  // ---------- 钩子 ----------
  if (p === '/hooks' && method === 'GET') {
    // 归一化：/hooks/trust 写进去的是 realpath，这里读到的 session.cwd 可能是
    // 原始写法（macOS 上 /var 与 /private/var 是同一个地方），不归一化会永远对不上，
    // 表现为「刚点了信任，刷新又变回未信任」。
    const raw = q.cwd || (q.session_id ? (loadSessionRecord(q.session_id)?.config?.cwd || null) : null);
    const cwd = raw ? realpathAllowMissing(raw) : null;
    const cfg = loadConfig();
    const trusted = cfg.trustProjectHooks === true
      || (Array.isArray(cfg.trustProjectHooksFor) && !!cwd && cfg.trustProjectHooksFor.includes(cwd));
    const d = describeHooks(cwd, { ...cfg, trustProjectHooks: trusted });
    return json(res, 200, { ...d, cwd, enabled: cfg.hooksEnabled !== false, events: HOOK_EVENTS });
  }
  if (p === '/hooks/trust' && method === 'POST') {
    try {
      const body = await readBody(req);
      const cwd = body?.cwd ? realpathAllowMissing(body.cwd) : null;
      if (!cwd) return apiError(res, 422, '需要 cwd');
      const list = new Set(loadConfig().trustProjectHooksFor || []);
      if (body?.trust === false) list.delete(cwd); else list.add(cwd);
      saveConfig({ trustProjectHooksFor: [...list] });
      return json(res, 200, { status: 'ok', cwd, trusted: body?.trust !== false, trustProjectHooksFor: [...list] });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }

  // ---------- 代码索引（符号 / 语义倒排）----------
  if (p === '/admin/index' && method === 'GET') {
    const cwd = q.cwd || (q.session_id ? (loadSessionRecord(q.session_id)?.config?.cwd || null) : null);
    if (!cwd) return apiError(res, 422, '需要 cwd 或带工作目录的 session_id');
    const sym = loadSymbolIndexStats(cwd);
    return json(res, 200, { cwd, semantic: indexStats(cwd), symbols: sym });
  }
  if (p === '/admin/index' && method === 'POST') {
    try {
      const body = await readBody(req).catch(() => ({}));
      const cwd = body?.cwd || q.cwd || (q.session_id ? (loadSessionRecord(q.session_id)?.config?.cwd || null) : null);
      if (!cwd) return apiError(res, 422, '需要 cwd 或带工作目录的 session_id');
      const root = realpathAllowMissing(cwd);
      const symbols = buildSymbolIndex(root, { force: body?.force !== false });
      const semantic = buildSemanticIndex(root, { force: body?.force !== false });
      return json(res, 200, { status: 'ok', cwd: root, symbols: { files: symbols.files, count: symbols.symbols.length, reused: symbols.reused }, semantic });
    } catch (e) { return apiError(res, 500, e?.message || String(e)); }
  }
  if (p === '/admin/lsp' && method === 'GET') {
    // 探测本机装了哪些 language server —— 设置页据此给出一键配置
    const known = [
      { ext: '.ts', command: 'typescript-language-server', args: ['--stdio'], label: 'TypeScript / JS' },
      { ext: '.py', command: 'pyright-langserver', args: ['--stdio'], label: 'Python (pyright)' },
      { ext: '.go', command: 'gopls', args: [], label: 'Go' },
      { ext: '.rs', command: 'rust-analyzer', args: [], label: 'Rust' },
      { ext: '.sh', command: 'bash-language-server', args: ['start'], label: 'Shell' }
    ];
    const installed = known.filter((k) => !!whichSync(k.command)).map((k) => {
      const bin = whichSync(k.command);
      const entry = { ...k, path: bin };
      // typescript-language-server 要在**被打开的项目里**找到 typescript，
      // 而绝大多数项目并不装 —— 不给 tsserver.path 它会直接退出，然后用户
      // 只会看到"回退到本地索引"。这里顺手在 server 自己的 node_modules 里
      // 找一个可用的 tsserver，一键配置才真的能用。
      const ts = k.ext === '.ts' ? findTsserverNear(bin) : null;
      if (ts) entry.initializationOptions = { tsserver: { path: ts } };
      return entry;
    });
    const cfg = loadConfig();
    return json(res, 200, {
      installed,
      configured: cfg.lspServers || {},
      hint: '把 installed 里的条目写进 config.json 的 lspServers 即可让 Lsp 工具走真 LSP（不配则用本地索引）',
      // 提示写 path 而不是 command：装在托管 workspace / 非 PATH 目录的服务端用
      // command 名会 spawn 失败，而失败是静默回退的 —— 用户会以为"配了没用"。
      pathHint: '建议把 path（绝对路径）写进 lspServers 的 command 字段'
    });
  }

  // ---------- 权限规则（允许清单）----------
  if (p === '/permission/rules' && method === 'GET') {
    const rules = listPermissionRules();
    return json(res, 200, { rules, total: rules.length });
  }
  if (p === '/permission/rules' && method === 'POST') {
    try {
      const body = await readBody(req);
      const rule = addPermissionRule(body?.rule ?? body);
      if (!rule) return apiError(res, 422, 'rule.tool_name 不能为空');
      return json(res, 200, { status: 'ok', rule, rules: listPermissionRules() });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }
  if (p === '/permission/rules' && method === 'DELETE') {
    // 三种写法都收：?all=1 / body {all:true} / body {index} 或 {rule}
    let payload = {};
    try { payload = await readBody(req); } catch { /* 允许空 body + query 指定 */ }
    if (q.all != null) payload.all = q.all;
    if (q.index != null) payload.index = Number(q.index);
    const wantAll = payload.all === true || payload.all === 'true' || payload.all === '1';
    if (wantAll) {
      clearPermissionRules();
      return json(res, 200, { status: 'ok', rules: [] });
    }
    const ok = deletePermissionRule(payload);
    if (!ok) return apiError(res, 404, '规则不存在');
    return json(res, 200, { status: 'ok', rules: listPermissionRules() });
  }

  // ---------- 记忆（Memory：跨会话长期记忆 CRUD + 配置） ----------
  if (p === '/memories' && method === 'GET') {
    // ?q= 走评分检索；否则全量列表 + scope/project_key 过滤（key 归一后匹配存储值）
    if (q.q) return json(res, 200, { memories: searchMemories(q.q, { limit: Number(q.limit) || 10 }) });
    const normKey = q.project_key ? String(realpathAllowMissing(q.project_key)) : '';
    const items = listMemories().filter((rec) =>
      (!q.scope || rec.scope === q.scope) && (!normKey || rec.project_key === normKey));
    return json(res, 200, { memories: items, total: items.length });
  }
  if (p === '/memories' && method === 'POST') {
    try {
      const body = await readBody(req);
      // API 手动创建一律记为 manual 来源（与工具写入 / 自动提炼区分）
      const { memory, deduped } = saveMemory({
        content: body?.content,
        kind: body?.kind ?? 'fact',
        scope: body?.scope,
        project_key: body?.project_key ?? '',
        source: 'manual',
        pinned: !!body?.pinned
      });
      return json(res, 200, { status: 'ok', memory, deduped });
    } catch (e) {
      if (e instanceof MemoryValidationError) return apiError(res, 400, e.message);
      return apiError(res, 500, e?.message || String(e));
    }
  }
  let mrec;
  if ((mrec = p.match(/^\/memories\/([\w-]+)$/)) && method === 'PATCH') {
    try {
      const body = await readBody(req);
      const patch = {};
      for (const k of ['content', 'kind', 'scope', 'project_key', 'pinned']) {
        if (body?.[k] !== undefined) patch[k] = body[k];
      }
      const next = updateMemory(mrec[1], patch);
      if (!next) return apiError(res, 404, '记忆不存在');
      return json(res, 200, { status: 'ok', memory: next });
    } catch (e) {
      if (e instanceof MemoryValidationError) return apiError(res, 400, e.message);
      return apiError(res, 500, e?.message || String(e));
    }
  }
  if ((mrec = p.match(/^\/memories\/([\w-]+)$/)) && method === 'DELETE') {
    if (!deleteMemory(mrec[1])) return apiError(res, 404, '记忆不存在');
    return json(res, 200, { status: 'ok' });
  }
  if (p === '/memory-config' && method === 'GET') {
    return json(res, 200, loadMemoryConfig());
  }
  if (p === '/memory-config' && method === 'POST') {
    try {
      const body = await readBody(req);
      return json(res, 200, saveMemoryConfig(body ?? {}));
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }

  // ---------- 内置终端（持久 shell；SSE 下行 + POST 上行，零依赖无 PTY） ----------
  let tm;
  if (p === '/terminal/create' && method === 'POST') {
    try {
      const body = await readBody(req);
      const cwd = typeof body.cwd === 'string' && body.cwd ? realpathAllowMissing(body.cwd) : process.cwd();
      return json(res, 200, createTerminal({ cwd, shell: typeof body.shell === 'string' ? body.shell : undefined }));
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }
  if ((tm = p.match(/^\/terminal\/([\w-]+)\/write$/)) && method === 'POST') {
    const body = await readBody(req);
    if (typeof body.data !== 'string') return apiError(res, 422, 'data 必须是字符串');
    if (!writeTerminal(tm[1], body.data)) return apiError(res, 404, '终端不存在或已退出');
    return json(res, 200, { status: 'ok' });
  }
  if ((tm = p.match(/^\/terminal\/([\w-]+)\/stream$/)) && method === 'GET') {
    if (!getTerminal(tm[1])) return apiError(res, 404, '终端不存在');
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    const replay = replayTerminal(tm[1]);
    if (replay.history) res.write(`data: ${JSON.stringify({ type: 'replay', data: replay.history })}\n\n`);
    if (replay.exited) {
      res.write(`data: ${JSON.stringify({ type: 'exit', code: replay.code })}\n\n`);
      res.end();
      return;
    }
    const send = (event) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
    };
    const unsub = subscribeTerminal(tm[1], send);
    const hb = setInterval(() => {
      try { res.write(': ka\n\n'); } catch { /* closed */ }
    }, 15000);
    req.on('close', () => { clearInterval(hb); unsub(); });
    return;
  }
  if ((tm = p.match(/^\/terminal\/([\w-]+)\/kill$/)) && method === 'POST') {
    if (!killTerminal(tm[1])) return apiError(res, 404, '终端不存在或已退出');
    return json(res, 200, { status: 'ok' });
  }
  // 代理拉模型列表：绕开浏览器 CORS 限制
  if (p === '/admin/models' && method === 'GET') {
    const target = (q.baseURL || loadConfig().baseURL || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(target)) return apiError(res, 400, 'baseURL 必须是 http(s) 地址');
    const headers = { accept: 'application/json' };
    if (q.apiKey) headers.authorization = `Bearer ${q.apiKey}`;
    try {
      const upstream = await fetch(target + '/models', {
        headers, signal: AbortSignal.timeout(12000)
      });
      if (!upstream.ok) return apiError(res, 502, `上游 ${target}/models 返回 ${upstream.status}`);
      const body = await upstream.json();
      const list = Array.isArray(body) ? body : body.data ?? body.models ?? [];
      const ids = list.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name))
        .filter((s) => typeof s === 'string');
      return json(res, 200, { models: ids });
    } catch (e) { return apiError(res, 502, `拉取模型列表失败: ${e?.message || e}`); }
  }

  // ---------- 多模型列表（设置窗口"模型"板块） ----------
  let mm;
  // 列表：apiKey 不回明文
  if (p === '/admin/models-config' && method === 'GET') {
    const cfg = loadConfig();
    const items = (Array.isArray(cfg.modelList) ? cfg.modelList : []).map((m) => ({
      id: m.id, provider: m.provider, label: m.label, model: m.model,
      baseURL: m.baseURL, enabled: !!m.enabled, apiKeySet: !!m.apiKey,
      vision: typeof m.vision === 'boolean' ? m.vision : null
    }));
    return json(res, 200, { models: items });
  }
  // 全量替换本地镜像：登录后前端把云端 /models 拉到的完整列表写进来，
  // 覆盖本地 config.modelList（core 运行时读它合成凭证）。PUT 语义 =
  // 完全以请求体为准，不是增量合并。
  if (p === '/admin/models-config' && method === 'PUT') {
    try {
      const body = await readBody(req);
      const models = Array.isArray(body.models) ? body.models : [];
      const list = models
        .map((m) => ({
          id: typeof m.id === 'string' && m.id ? m.id : `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          provider: String(m.provider ?? 'custom'),
          label: String(m.label ?? m.provider ?? ''),
          model: String(m.model ?? '').trim(),
          baseURL: String(m.baseURL ?? '').trim().replace(/\/+$/, ''),
          apiKey: String(m.apiKey ?? ''),
          enabled: m.enabled !== false,
          ...(m.vision === null || typeof m.vision === 'boolean' ? { vision: m.vision } : {}),
          ...(typeof m.isOfficial === 'boolean' ? { isOfficial: m.isOfficial } : {}),
          ...(typeof m.tier === 'string' && m.tier ? { tier: m.tier } : {}),
        }))
        .filter((m) => m.model && /^https?:\/\//.test(m.baseURL));
      saveConfig({ modelList: list });
      const next = syncEffectiveModel();
      return json(res, 200, { status: 'ok', count: list.length, effective: { baseURL: next.baseURL, model: next.model, apiKeySet: !!next.apiKey } });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }
  // 添加（支持批量：body.models: string[] 一次加多个，复用同一 baseURL/apiKey/provider；
  //       apiKey 留空时从同 provider+baseURL 已有条目复用——同一供应商多个模型只需填一次 key）
  if (p === '/admin/models-config' && method === 'POST') {
    try {
      const body = await readBody(req);
      const baseRaw = String(body.baseURL ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(baseRaw)) return apiError(res, 422, 'baseURL 必须是 http(s) 地址');
      const cfg = loadConfig();
      const list = Array.isArray(cfg.modelList) ? [...cfg.modelList] : [];
      const provider = String(body.provider ?? 'custom');
      const label = String(body.label ?? body.provider ?? '自定义');
      const apiKeyRaw = String(body.apiKey ?? '').trim();
      // 同供应商+baseURL 已有条目：apiKey 留空时复用其 key（同一 Key 加多模型的核心）
      const sibling = list.find((x) => x.provider === provider && x.baseURL === baseRaw);
      const apiKey = apiKeyRaw || sibling?.apiKey || '';
      const vision = typeof body.vision === 'boolean' ? body.vision : (sibling && typeof sibling.vision === 'boolean' ? sibling.vision : null);
      const models = Array.isArray(body.models) && body.models.length
        ? body.models.map((s) => String(s).trim()).filter(Boolean)
        : [String(body.model ?? '').trim()].filter(Boolean);
      if (models.length === 0) return apiError(res, 422, 'model 不能为空');
      let added = 0, updated = 0;
      for (const model of models) {
        const dup = list.findIndex((x) => x.provider === provider && x.model.toLowerCase() === model.toLowerCase());
        if (dup >= 0) {
          if (apiKey) list[dup] = { ...list[dup], apiKey, baseURL: baseRaw };
          list[dup].vision = vision;
          list[dup].enabled = true;
          updated++;
        } else {
          list.push({
            id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            provider, label, model, baseURL: baseRaw, apiKey, enabled: true, vision,
          });
          added++;
        }
      }
      saveConfig({ modelList: list });
      const next = syncEffectiveModel();
      return json(res, 200, { status: 'ok', added, updated, effective: { baseURL: next.baseURL, model: next.model, apiKeySet: !!next.apiKey } });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }
  // 编辑：PATCH /admin/models-config/:id（apiKey 空/缺省 = 保留原值）
  if ((mm = p.match(/^\/admin\/models-config\/([\w-]+)\/toggle$/)) && method === 'POST') {
    try {
      const body = await readBody(req);
      const cfg = loadConfig();
      const list = Array.isArray(cfg.modelList) ? [...cfg.modelList] : [];
      const idx = list.findIndex((x) => x.id === mm[1]);
      if (idx < 0) return apiError(res, 404, '模型不存在');
      list[idx].enabled = body.enabled !== false;
      saveConfig({ modelList: list });
      const next = syncEffectiveModel();
      return json(res, 200, { status: 'ok', effective: { baseURL: next.baseURL, model: next.model, apiKeySet: !!next.apiKey } });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }
  if ((mm = p.match(/^\/admin\/models-config\/([\w-]+)$/))) {
    try {
      const cfg = loadConfig();
      const list = Array.isArray(cfg.modelList) ? [...cfg.modelList] : [];
      const idx = list.findIndex((x) => x.id === mm[1]);
      if (idx < 0) return apiError(res, 404, '模型不存在');
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (typeof body.model === 'string' && body.model.trim()) list[idx].model = body.model.trim();
        if (typeof body.baseURL === 'string' && /^https?:\/\//.test(body.baseURL.trim())) {
          list[idx].baseURL = body.baseURL.trim().replace(/\/+$/, '');
        }
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) list[idx].apiKey = body.apiKey.trim();
        if (typeof body.label === 'string' && body.label.trim()) list[idx].label = body.label.trim();
        if (typeof body.enabled === 'boolean') list[idx].enabled = body.enabled;
        // vision：true/false 强制开关；null 恢复「按模型名自动判断」
        if (body.vision === null || typeof body.vision === 'boolean') list[idx].vision = body.vision;
        saveConfig({ modelList: list });
      } else if (method === 'DELETE') {
        list.splice(idx, 1);
        saveConfig({ modelList: list });
      }
      const next = syncEffectiveModel();
      return json(res, 200, { status: 'ok', effective: { baseURL: next.baseURL, model: next.model, apiKeySet: !!next.apiKey } });
    } catch (e) { return apiError(res, 400, e?.message || String(e)); }
  }

  // ---------- 套餐（Coding Plan / Token Plan） ----------
  // GET /admin/plans                 → 目录 + 各套餐接入状态
  // POST /admin/plans/:key/connect   → {apiKey} → 按套餐默认模型批量写入 modelList（专用端点内置）
  // DELETE /admin/plans/:key/connect → 断开（禁用该套餐专用端点的所有模型条目）
  if (p === '/admin/plans' && method === 'GET') {
    const cfg = loadConfig();
    // connected：modelList 中存在 baseURL 匹配且填了 key 的条目
    const plans = PLAN_DEFS.map((def) => {
      const hit = (Array.isArray(cfg.modelList) ? cfg.modelList : []).find(
        (x) => x.baseURL === def.baseURL && x.apiKey);
      return {
        key: def.key, name: def.name, vendor: def.vendor, note: def.note,
        models: def.models, keyUrl: def.keyUrl, buyUrl: def.buyUrl,
        connected: !!hit,
      };
    });
    return json(res, 200, { plans });
  }
  if ((mm = p.match(/^\/admin\/plans\/([\w-]+)\/connect$/)) && method === 'POST') {
    const def = getPlanDef(mm[1]);
    if (!def) return apiError(res, 404, '套餐不存在');
    const body = await readBody(req);
    const apiKey = String(body.apiKey ?? '').trim();
    if (!apiKey) return apiError(res, 422, 'apiKey 不能为空');
    // 写入前鉴权探活：用套餐专用端点 GET /models 做一次轻量校验。
    // 只拦截「明确的鉴权/订阅失败」；网络异常、超时或不支持列举模型的端点
    // 一律放行，避免探针自身的兼容性误杀可用配置。
    try {
      const probe = await fetch(def.baseURL + '/models', {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (probe.status === 401 || probe.status === 403) {
        return apiError(res, probe.status,
          `API Key 校验未通过（HTTP ${probe.status}）。请确认：1) 粘贴的是「${def.name}」套餐专属 API Key，与平台按量计费的普通 Key 不通用；2) Key 未被删除或禁用；3) 创建该 Key 的账号已订阅套餐且在有效期内。`);
      }
      if (probe.status === 400) {
        const pb = await probe.text().catch(() => '');
        if (/InvalidSubscription|does not have a valid [^"]*subscription|subscription has expired/i.test(pb)) {
          return apiError(res, 400,
            `该账号未订阅「${def.name}」或套餐已过期，请先完成订阅或续费后再接入。`);
        }
      }
    } catch { /* 网络异常/超时不阻塞接入 */ }
    const cfg = loadConfig();
    const list = Array.isArray(cfg.modelList) ? [...cfg.modelList] : [];
    let added = 0, updated = 0;
    for (const model of def.models) {
      const idx = list.findIndex((x) => x.baseURL === def.baseURL && x.model.toLowerCase() === model.toLowerCase());
      if (idx >= 0) { list[idx].apiKey = apiKey; list[idx].enabled = true; updated++; }
      else {
        list.push({
          id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          provider: def.key, label: def.name, model, baseURL: def.baseURL,
          apiKey, enabled: true,
        });
        added++;
      }
    }
    // 同步清理：套餐目录已下架/改名的旧模型条目（仅清理本套餐自动写入的条目，
    // 用户自定义同端点条目不触碰）
    let removed = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i];
      if (x.provider === def.key && x.baseURL === def.baseURL
        && !def.models.some((m) => m.toLowerCase() === String(x.model ?? '').toLowerCase())) {
        list.splice(i, 1);
        removed++;
      }
    }
    saveConfig({ modelList: list });
    const next = syncEffectiveModel();
    return json(res, 200, { status: 'ok', added, updated, removed, effective: { baseURL: next.baseURL, model: next.model, apiKeySet: !!next.apiKey } });
  }
  if ((mm = p.match(/^\/admin\/plans\/([\w-]+)\/connect$/)) && method === 'DELETE') {
    const def = getPlanDef(mm[1]);
    if (!def) return apiError(res, 404, '套餐不存在');
    const cfg = loadConfig();
    const list = Array.isArray(cfg.modelList) ? [...cfg.modelList] : [];
    // 断开 = 彻底移除该套餐专用端点的所有条目（只禁用的话 connected 判定
    // 仍会命中 apiKey，前端表现为"断不开"）
    const kept = list.filter((x) => x.baseURL !== def.baseURL);
    const removed = list.length - kept.length;
    saveConfig({ modelList: kept });
    const next = syncEffectiveModel();
    return json(res, 200, { status: 'ok', removed, effective: { baseURL: next.baseURL, model: next.model, apiKeySet: !!next.apiKey } });
  }

  if (p === '/agent/' && method === 'GET') {
    const agents = listAgents();
    return json(res, 200, { agents, total: agents.length });
  }
  if (p === '/agent/' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name?.trim()) return apiError(res, 422, 'name 不能为空');
    const agent = createAgent(body);
    return json(res, 200, { agent_id: agent.id });
  }
  if (p === '/agent/schema/v2' && method === 'GET') {
    return json(res, 200, AGENT_SCHEMA);
  }
  let m;
  if ((m = p.match(/^\/agent\/([\w-]+)$/))) {
    if (method === 'PATCH') {
      const body = await readBody(req);
      const agent = updateAgent(m[1], body);
      return agent ? json(res, 200, agent) : apiError(res, 404, 'agent 不存在');
    }
    if (method === 'DELETE') {
      deleteAgent(m[1]);
      return json(res, 200, { status: 'ok' });
    }
    if (method === 'GET') {
      const agent = getAgent(m[1]);
      return agent ? json(res, 200, agent) : apiError(res, 404, 'agent 不存在');
    }
  }

  // ---------- Sessions ----------
  if (p === '/sessions/' && method === 'GET') {
    const views = listSessionRecords()
      .filter((s) => !q.agent_id || s.agent_id === q.agent_id)
      .map((s) => ({
        ...toSessionView(s, isRunning(s.id) ? 'running' : 'idle'),
        awaiting_confirm: isAwaitingConfirm(s.id)
      }));
    return json(res, 200, { sessions: views, total: views.length });
  }
  if (p === '/sessions/' && method === 'POST') {
    const body = await readBody(req);
    if (!body.agent_id) return apiError(res, 422, 'agent_id 不能为空');
    // 死 agent_id 一律 404：否则会产出指向不存在 agent 的会话，
    // 前端之后每条消息都撞 404 "agent 不存在"，还无处自救。
    if (!getAgent(body.agent_id)) return apiError(res, 404, 'agent 不存在');
    const record = createSessionRecord({
      agent_id: body.agent_id,
      chat_model_config: body.chat_model_config || null,
      fallback_chat_model_config: body.fallback_chat_model_config || null,
      vegaCfg: loadConfig(),
      cwd: body.cwd || null,
    });
    // 无会话时前端把权限模式记在本地，随第一条消息带过来 —— 与 cwd 同一策略。
    if (body.permission_mode) {
      record.state.permission_mode = body.permission_mode;
      record.state.permission_context = {
        ...(record.state.permission_context && typeof record.state.permission_context === 'object'
          ? record.state.permission_context : {}),
        mode: body.permission_mode
      };
      saveSessionRecord(record);
    }
    return json(res, 200, { session_id: record.id });
  }
  // 会话检索 / 分支 / 导出 —— 必须排在 /sessions/:id 的通配匹配之前，
  // 否则 "search" 会被当成会话 id 吃掉。
  if (p === '/sessions/search' && method === 'GET') {
    const results = searchSessions(q.q || q.query || '', {
      agent_id: q.agent_id || undefined,
      limit: Number(q.limit) || 50
    });
    return json(res, 200, { results, total: results.length, query: q.q || q.query || '' });
  }
  if ((m = p.match(/^\/sessions\/([\w-]+)\/fork$/)) && method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch { /* 允许空 body */ }
    const r = forkSession(m[1], { upto: Number.isFinite(Number(body.upto)) ? Number(body.upto) : undefined, name: body.name });
    if (!r) return apiError(res, 404, '会话不存在');
    return json(res, 200, { status: 'ok', session_id: r.id, name: r.name, message_count: r.messages });
  }
  if ((m = p.match(/^\/sessions\/([\w-]+)\/export$/)) && method === 'GET') {
    const r = exportSession(m[1], q.format === 'json' ? 'json' : 'md');
    if (!r) return apiError(res, 404, '会话不存在');
    if (q.download === '1') {
      const ext = r.format === 'json' ? 'json' : 'md';
      res.writeHead(200, {
        'content-type': r.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="session-${m[1]}.${ext}"`
      });
      return res.end(r.body);
    }
    return json(res, 200, r);
  }
  // 检查点：列出 / 回滚到第 N 轮
  if ((m = p.match(/^\/sessions\/([\w-]+)\/checkpoints$/)) && method === 'GET') {
    return json(res, 200, { checkpoints: listCheckpoints(m[1]) });
  }
  if ((m = p.match(/^\/sessions\/([\w-]+)\/checkpoints\/(\d+)\/restore$/)) && method === 'POST') {
    const rec = loadSessionRecord(m[1]);
    if (!rec) return apiError(res, 404, '会话不存在');
    if (isRunning(m[1])) return apiError(res, 409, '会话正在运行，先中止再回滚');
    const r = restoreCheckpoint(m[1], Number(m[2]), rec.config?.cwd || null);
    if (!r.ok) return apiError(res, 400, r.reason);
    return json(res, 200, { status: 'ok', ...r });
  }
  if ((m = p.match(/^\/sessions\/([\w-]+)\/checkpoints$/)) && method === 'DELETE') {
    clearCheckpoints(m[1]);
    return json(res, 200, { status: 'ok' });
  }
  if ((m = p.match(/^\/sessions\/([\w-]+)$/))) {
    const [, id] = m;
    if (method === 'PATCH') {
      const body = await readBody(req);
      const s = loadSessionRecord(id);
      if (!s) return apiError(res, 404, '会话不存在');
      if (isRunning(id)) return apiError(res, 409, '会话正在运行，配置已被快照，稍后再改');
      if (typeof body.name === 'string') {
        s.config.name = body.name.slice(0, 40);
        s.config.naming = { auto: false };
      }
      if (body.chat_model_config) {
        const prev = s.config.chat_model_config;
        const next = body.chat_model_config;
        // 首次选模型（此前未设置，或仅有会话创建时注入的默认模型——
        // 用户从未主动选过）不算"切换"，不提示；只有用户上一次主动
        // 选择过的模型名发生变更才提示。user_selected 标记随上次
        // PATCH 写入，是"这次变更是否值得提示"的判据。
        const hadUserSelected = !!prev?.model && !!prev.user_selected;
        const changed = hadUserSelected && String(prev.model) !== String(next.model || '');
        s.config.chat_model_config = { ...next, user_selected: true };
        if (changed) {
          // 模型切换提示（会话级事实，落盘进 display：刷新后仍可见）。
          // 只记录模型名维度；credential/参数等静默变更不打扰时间线。
          (s.display ||= []).push(systemNoticeMsg(
            `模型已从 ${prev?.model || '（未设置）'} 更改为 ${next.model || '（未设置）'}`,
            { kind: 'model_switch', from: prev?.model ?? null, to: next.model ?? null },
          ));
        }
      }
      if ('fallback_chat_model_config' in body) s.config.fallback_chat_model_config = body.fallback_chat_model_config ?? null;
      if ('cwd' in body) {
        s.config.cwd = body.cwd ?? null;
        if (body.cwd) addWorkspaceRecent(body.cwd);
      }
      if (body.permission_mode) {
        // 前端通过 state_updated SSE / PermissionPanel 读
        // state.permission_context.mode —— 当初老 store 把 mode 平铺在
        // state.permission_mode 上，结果 PATCH 后 view refetch 回来，
        // useEffect 又把显示值拉回 'default'，看似没切换。
        // 这里同时写两个字段以保证新旧读法均生效。
        s.state.permission_mode = body.permission_mode;
        const ctx = s.state.permission_context && typeof s.state.permission_context === 'object'
          ? s.state.permission_context : {};
        s.state.permission_context = { ...ctx, mode: body.permission_mode };
      }
      return json(res, 200, toSessionView(saveSessionRecord(s), 'idle').session);
    }
    if (method === 'DELETE') {
      if (isRunning(id)) return apiError(res, 409, '会话正在运行，无法删除');
      deleteSession(id);
      return json(res, 200, { status: 'ok' });
    }
    if (method === 'GET') {
      const s = loadSessionRecord(id);
      return s ? json(res, 200, {
        ...toSessionView(s, isRunning(id) ? 'running' : 'idle'),
        awaiting_confirm: isAwaitingConfirm(id)
      }) : apiError(res, 404, '会话不存在');
    }
  }
  if ((m = p.match(/^\/sessions\/([\w-]+)\/messages$/)) && method === 'GET') {
    const s = loadSessionRecord(m[1]);
    if (!s) return apiError(res, 404, '会话不存在');
    return json(res, 200, { messages: s.display || [], is_running: isRunning(m[1]), has_more: false });
  }
  if ((m = p.match(/^\/sessions\/([\w-]+)\/stream$/)) && method === 'GET') {
    const sid = m[1];
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    const send = (event) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
    };
    const unsub = subscribe(sid, send);
    const hb = setInterval(() => {
      try { res.write(': ka\n\n'); } catch { /* closed */ }
    }, 15000);
    req.on('close', () => { clearInterval(hb); unsub(); });
    return;
  }
  if ((m = p.match(/^\/sessions\/([\w-]+)\/interrupt$/)) && method === 'POST') {
    const interrupted = interrupt(m[1]);
    return json(res, 202, { session_id: m[1], interrupted });
  }

  // ---------- Chat ----------
  if (p === '/chat/' && method === 'POST') {
    const body = await readBody(req);
    const { agent_id, session_id, input, auto_context, selected_skill_ids } = body;
    if (!session_id || !agent_id) return apiError(res, 422, '需要 agent_id 与 session_id');

    // AskUserQuestion 作答：前端把问题面板的答案当 input POST 回来（同
    // USER_CONFIRM_RESULT，不开启新 run，只唤醒挂起的那一轮）。
    if (input && typeof input === 'object' && input.type === 'USER_QUESTION_ANSWER') {
      const r = resolveQuestion(session_id, input);
      return json(res, 200, { status: r.notRunning ? 'stale' : 'ok', session_id, resolved: r.resolved, stale: r.stale, not_running: r.notRunning });
    }

    // HITL 回复：前端把 UserConfirmResultEvent 当 input POST 回来。
    // 先于"新消息"判定处理 —— 它不会开启新一轮 run，而是唤醒挂起的那一轮。
    if (input && typeof input === 'object' && input.type === 'USER_CONFIRM_RESULT') {
      const r = resolveConfirm(session_id, input);
      if (r.notRunning) {
        // 迟到的确认答复（run 已结束/被中止/服务重启）：残留卡片已在
        // resolveConfirm 内作废。返回 200 而非 409 —— 用户没赶上不算
        // 客户端错误，前端不必弹错。
        return json(res, 200, { status: 'stale', session_id, resolved: 0, stale: r.stale, not_running: true });
      }
      return json(res, 200, { status: 'ok', session_id, resolved: r.resolved, stale: r.stale });
    }

    const agent = getAgent(agent_id);
    if (!agent) return apiError(res, 404, 'agent 不存在');
    const text = inputToText(input);
    // 图片输入：input.content 里的 image 块（data_url / url / base64 data 三种形态）。
    // base64 必须拼回完整 data URL（data:image/png;base64,xxx），
    // OpenAI 兼容端点只认这种形态，裸 base64 会 400。
    const images = (Array.isArray(input?.content) ? input.content : [])
      .filter((b) => b && (b.type === 'image' || b.type === 'image_url' || b.type === 'data'))
      .map((b) => {
        const meta = { name: b.name || null, media_type: b.source?.media_type || null };
        if (b.data_url) return { data_url: b.data_url, ...meta };
        if (b.url) return { data_url: b.url, ...meta };
        if (b.source?.type === 'url' && b.source?.url) return { data_url: b.source.url, ...meta };
        if (b.source?.type === 'base64' && b.source?.data) {
          const mt = b.source.media_type || 'image/png';
          return { data_url: `data:${mt};base64,${b.source.data}`, ...meta };
        }
        return { data_url: null };
      })
      .filter((b) => b.data_url);
    if (input && !text && !images.length) return apiError(res, 422, '仅支持文本与图片输入');
    // auto_context 是"客户端隐身打包、模型可见"的隐式块：cwd/git/
    // 历史/工具列表拼成一段文本，在 internal（LLM prompt）里会拼到
    // 用户消息之前，但不入 display（用户视角历史）。
    const contextText = inputToText({ content: Array.isArray(auto_context) ? auto_context : [] });
    if (!text && !contextText && !images.length) return json(res, 200, { status: 'ok', session_id }); // 续跑/空输入：no-op
    const run = startChatRun(session_id, agent, {
      userText: text,
      contextText,
      images,
      // 只用于 display 气泡上的技能 chip；技能正文在 auto_context 里。
      selected_skill_ids: Array.isArray(selected_skill_ids) ? selected_skill_ids : [],
    });
    if (run.error) return apiError(res, 409, run.error);
    return json(res, 200, { status: 'ok', session_id });
  }

  // ---------- Credential ----------
  // 合并手动凭证 + 设置窗口模型列表合成的 cocode-models（仅在有启用模型时出现）
  if (p === '/credential/' && method === 'GET') {
    const cfg = loadConfig();
    const credentials = [...listCredentials(), ...(enabledModels(cfg).length ? [cocodeCredential(cfg)] : [])];
    return json(res, 200, { credentials, total: credentials.length });
  }
  if (p === '/credential/schemas' && method === 'GET') {
    return json(res, 200, CREDENTIAL_SCHEMAS);
  }
  if (p === '/credential/' && method === 'POST') {
    const body = await readBody(req);
    if (body.data?.type !== 'openai_compatible') return apiError(res, 422, '仅支持 openai_compatible');
    if (!body.data?.base_url) return apiError(res, 422, 'base_url 不能为空');
    const cred = createCredential(body.data);
    return json(res, 200, { credential_id: cred.id });
  }
  if ((m = p.match(/^\/credential\/([\w-]+)$/))) {
    if (method === 'PATCH') {
      const body = await readBody(req);
      const cred = updateCredential(m[1], body.data || {});
      return cred ? json(res, 200, cred) : apiError(res, 404, '凭证不存在');
    }
    if (method === 'DELETE') {
      deleteCredential(m[1]);
      return json(res, 200, { status: 'ok' });
    }
  }

  // ---------- Model ----------
  // 优先用设置窗口模型列表的启用项；为空时退回内置默认
  if (p === '/model/' && method === 'GET') {
    const cfg = loadConfig();
    const enabled = enabledModels(cfg);
    const cards = enabled.length
      ? enabled.map((x) => ({
          type: 'chat_model', name: x.model, label: `${x.label || x.provider} / ${x.model}`,
          status: 'active', deprecated_at: null,
          input_types: inputTypesFor(x.model, x.vision), output_types: ['text'],
          context_size: 128000, output_size: 16384,
          parameter_schema: {
            type: 'object',
            properties: { temperature: { type: 'number', title: 'Temperature', minimum: 0, maximum: 2 } }
          },
          parameters_overrides: {}
        }))
      : modelCards(cfg);
    return json(res, 200, { models: cards, total: cards.length });
  }
  if (p === '/tts-model/' || p === '/embedding-model/') {
    return json(res, 200, { models: [], total: 0 });
  }

  // ---------- Workspace ----------
  if (p === '/workspace/directories' && method === 'GET') {
    // 工作目录必须以当前会话选中的为准；不接收 process.cwd() 兜底，
    // 避免 Electron 进程的 cwd（CoCode 包根）泄漏成默认工作区。
    let root = null;
    if (q.session_id) {
      const rec = loadSessionRecord(q.session_id);
      root = rec?.config?.cwd || null;
    }
    if (!root) return json(res, 200, { path: null, entries: [], needsCwd: true });
    const target = q.path ? join(root, q.path) : root;
    const entries = [];
    try {
      for (const name of readdirSync(target)) {
        if (name.startsWith('.')) continue;
        const full = join(target, name);
        try {
          const st = statSync(full);
          entries.push({
            name, is_dir: st.isDirectory(),
            size_bytes: st.isDirectory() ? null : st.size,
            updated_at: Math.floor(st.mtimeMs / 1000)
          });
        } catch { /* 无权限跳过 */ }
      }
    } catch (e) { return apiError(res, 400, `无法列出目录: ${e.message}`); }
    entries.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
    return json(res, 200, { path: target, entries });
  }
  if (p === '/workspace/status' && method === 'GET') {
    // 同上：cwd 严格取自 session.config.cwd；未选工作目录时诚实返回 null。
    let cwd = null;
    if (q.session_id) {
      const rec = loadSessionRecord(q.session_id);
      cwd = rec?.config?.cwd || null;
    }
    if (!cwd) return json(res, 200, { workdir: null, cwd: null, git: null });
    // git 字段从占位 null 变成真实状态（分支/脏文件/ahead-behind）
    const root = realpathAllowMissing(cwd);
    let git = null;
    try { git = await readGitInfo(root); } catch { git = { is_repo: false }; }
    const checkpoints = q.session_id ? listCheckpoints(q.session_id).slice(-5) : [];
    return json(res, 200, { workdir: root, cwd: root, git, checkpoints });
  }
  // 变更预览：把当前工作区的 diff 直接给前端（不用先跑一轮工具）
  if (p === '/workspace/diff' && method === 'GET') {
    if (!q.session_id) return apiError(res, 422, '需要 session_id');
    const rec = loadSessionRecord(q.session_id);
    const cwd = rec?.config?.cwd || null;
    if (!cwd) return apiError(res, 422, '该会话还没有工作目录');
    const root = realpathAllowMissing(cwd);
    // 参数数组直接透传，避免 shell 注入；只允许只读的 diff 相关写法
    const args = ['diff'];
    if (q.staged === '1') args.push('--cached');
    if (q.path) args.push('--', String(q.path));
    const r = await runGit(args, root);
    if (!r.ok && r.code !== 0) {
      return json(res, 200, { diff: '', error: (r.stderr || '').trim() || 'git diff 失败（可能不是 git 仓库）' });
    }
    let diff = r.stdout;
    const MAX = 200000;
    if (diff.length > MAX) diff = diff.slice(0, MAX) + '\n…[diff 过长，已截断]';
    return json(res, 200, { diff, root });
  }
  // ── Git 深度集成：分支 / 工作树 / 暂存 / 提交 / 日志 ──
  // 所有端点从 session_id（或 body.cwd）取工作目录，与 /workspace/* 同一套路。
  if (p === '/git/branches' && method === 'GET') {
    const rec = q.session_id ? loadSessionRecord(q.session_id) : null;
    const cwd = q.cwd || rec?.config?.cwd || null;
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await listBranches(realpathAllowMissing(cwd));
    if (!r.ok) return apiError(res, 500, r.error);
    return json(res, 200, { branches: r.branches });
  }
  if (p === '/git/branches' && method === 'POST') {
    const body = await readBody(req);
    const cwd = body.cwd || (body.session_id ? loadSessionRecord(body.session_id)?.config?.cwd : null);
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await createBranch(realpathAllowMissing(cwd), body.name, body.from);
    if (!r.ok) return apiError(res, 400, r.error);
    return json(res, 200, { status: 'ok' });
  }
  if ((m = p.match(/^\/git\/branches\/([^/]+)\/switch$/)) && method === 'POST') {
    const body = await readBody(req);
    const cwd = body.cwd || (body.session_id ? loadSessionRecord(body.session_id)?.config?.cwd : null);
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await switchBranch(realpathAllowMissing(cwd), decodeURIComponent(m[1]));
    if (!r.ok) return apiError(res, 400, r.error);
    return json(res, 200, { status: 'ok', git: await readGitInfo(realpathAllowMissing(cwd)) });
  }
  if ((m = p.match(/^\/git\/branches\/([^/]+)$/)) && method === 'DELETE') {
    const cwd = q.cwd || (q.session_id ? loadSessionRecord(q.session_id)?.config?.cwd : null);
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await deleteBranch(realpathAllowMissing(cwd), decodeURIComponent(m[1]), q.force === '1');
    if (!r.ok) return apiError(res, 400, r.error);
    return json(res, 200, { status: 'ok' });
  }
  if (p === '/git/worktrees' && method === 'GET') {
    const rec = q.session_id ? loadSessionRecord(q.session_id) : null;
    const cwd = q.cwd || rec?.config?.cwd || null;
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await listWorktrees(realpathAllowMissing(cwd));
    if (!r.ok) return apiError(res, 500, r.error);
    return json(res, 200, { worktrees: r.worktrees });
  }
  if (p === '/git/worktrees' && method === 'POST') {
    const body = await readBody(req);
    const cwd = body.cwd || (body.session_id ? loadSessionRecord(body.session_id)?.config?.cwd : null);
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await createWorktree(realpathAllowMissing(cwd), body.path, body.branch, body.from);
    if (!r.ok) return apiError(res, 400, r.error);
    return json(res, 200, { status: 'ok' });
  }
  if (p === '/git/worktrees' && method === 'DELETE') {
    // DELETE 通常不带 body，path/force 走 query；同时兼容 body（curl/脚本）
    const body = await readBody(req);
    const path = q.path || body?.path;
    const cwd = q.cwd || body?.cwd || (q.session_id ? loadSessionRecord(q.session_id)?.config?.cwd : (body?.session_id ? loadSessionRecord(body.session_id)?.config?.cwd : null));
    if (!cwd || !path) return apiError(res, 422, '需要 session_id/cwd 和 path');
    const r = await removeWorktree(realpathAllowMissing(cwd), path, q.force === '1' || body?.force === true);
    if (!r.ok) return apiError(res, 400, r.error);
    return json(res, 200, { status: 'ok' });
  }
  if (p === '/git/stage' && method === 'POST') {
    const body = await readBody(req);
    const cwd = body.cwd || (body.session_id ? loadSessionRecord(body.session_id)?.config?.cwd : null);
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await stageFiles(realpathAllowMissing(cwd), body.paths || []);
    if (!r.ok) return apiError(res, 400, r.error);
    return json(res, 200, { status: 'ok' });
  }
  if (p === '/git/unstage' && method === 'POST') {
    const body = await readBody(req);
    const cwd = body.cwd || (body.session_id ? loadSessionRecord(body.session_id)?.config?.cwd : null);
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await unstageFiles(realpathAllowMissing(cwd), body.paths || []);
    if (!r.ok) return apiError(res, 400, r.error);
    return json(res, 200, { status: 'ok' });
  }
  if (p === '/git/status-files' && method === 'GET') {
    const rec = q.session_id ? loadSessionRecord(q.session_id) : null;
    const cwd = q.cwd || rec?.config?.cwd || null;
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await statusFiles(realpathAllowMissing(cwd));
    if (!r.ok) return apiError(res, 500, r.error);
    return json(res, 200, r);
  }
  if (p === '/git/commit' && method === 'POST') {
    const body = await readBody(req);
    const cwd = body.cwd || (body.session_id ? loadSessionRecord(body.session_id)?.config?.cwd : null);
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await commit(realpathAllowMissing(cwd), body.message);
    if (!r.ok) return apiError(res, 400, r.error);
    return json(res, 200, { status: 'ok', git: await readGitInfo(realpathAllowMissing(cwd)) });
  }
  if (p === '/git/log' && method === 'GET') {
    const rec = q.session_id ? loadSessionRecord(q.session_id) : null;
    const cwd = q.cwd || rec?.config?.cwd || null;
    if (!cwd) return apiError(res, 422, '需要 session_id 或 cwd');
    const r = await gitLog(realpathAllowMissing(cwd), q.limit);
    if (!r.ok) return apiError(res, 500, r.error);
    return json(res, 200, { commits: r.commits });
  }
  // ── 事件触发自动化规则 ──
  if (p === '/automations' && method === 'GET') {
    return json(res, 200, { automations: listAutomations() });
  }
  if (p === '/automations' && method === 'POST') {
    const body = await readBody(req);
    const r = createAutomation(body);
    return json(res, 200, r);
  }
  if ((m = p.match(/^\/automations\/([\w-]+)$/)) && method === 'PATCH') {
    const body = await readBody(req);
    const r = updateAutomation(m[1], body);
    if (!r) return apiError(res, 404, '规则不存在');
    return json(res, 200, r);
  }
  if ((m = p.match(/^\/automations\/([\w-]+)$/)) && method === 'DELETE') {
    deleteAutomation(m[1]);
    return json(res, 200, { status: 'ok' });
  }
  // ── Teams（多智能体团队协作） ──
  if (p === '/teams' && method === 'GET') {
    return json(res, 200, listTeamsStore());
  }
  if (p === '/teams' && method === 'POST') {
    const body = await readBody(req);
    if (!body.leader_session_id) return apiError(res, 422, '需要 leader_session_id');
    if (!body.leader_agent_id) return apiError(res, 422, '需要 leader_agent_id');
    if (!body.name) return apiError(res, 422, '需要 name');
    const t = createTeamStore(body);
    return json(res, 200, t);
  }
  if ((m = p.match(/^\/teams\/([\w-]+)$/)) && method === 'GET') {
    const t = getTeamStore(m[1]);
    if (!t) return apiError(res, 404, '团队不存在');
    return json(res, 200, t);
  }
  if ((m = p.match(/^\/teams\/([\w-]+)\/doc$/)) && method === 'GET') {
    const t = getTeamStore(m[1]);
    if (!t) return apiError(res, 404, '团队不存在');
    const docPath = getTeamDocPath(m[1]);
    if (!existsSync(docPath)) return apiError(res, 404, '团队文档不存在');
    return json(res, 200, { team_id: m[1], content: readFileSync(docPath, 'utf8') });
  }
  if ((m = p.match(/^\/teams\/([\w-]+)$/)) && method === 'PATCH') {
    const body = await readBody(req);
    const t = getTeamStore(m[1]);
    if (!t) return apiError(res, 404, '团队不存在');
    if (t.leader_session_id !== q.session_id) return apiError(res, 403, '只有队长能修改团队');
    const updated = updateTeamStore(m[1], body);
    if (!updated) return apiError(res, 404, '团队不存在');
    return json(res, 200, updated);
  }
  if ((m = p.match(/^\/teams\/([\w-]+)$/)) && method === 'DELETE') {
    const t = getTeamStore(m[1]);
    if (!t) return apiError(res, 404, '团队不存在');
    if (t.leader_session_id !== q.session_id) return apiError(res, 403, '只有队长能解散团队');
    disbandTeamStore(m[1]);
    return json(res, 200, { status: 'ok' });
  }
  // 会话通知队列（自动化 notify 动作产出）
  if ((m = p.match(/^\/sessions\/([\w-]+)\/notifications$/)) && method === 'GET') {
    return json(res, 200, { notifications: drainNotifications(m[1]) });
  }
  // 单文件读取（给"变更预览"里的文件查看器用）：只允许读工作目录内的文件
  if (p === '/workspace/file' && method === 'GET') {
    if (!q.session_id || !q.path) return apiError(res, 422, '需要 session_id 与 path');
    const rec = loadSessionRecord(q.session_id);
    const cwd = rec?.config?.cwd || null;
    if (!cwd) return apiError(res, 422, '该会话还没有工作目录');
    const { resolveInRoots } = await import('../security.js');
    const hit = resolveInRoots(q.path, [realpathAllowMissing(cwd)]);
    if (!hit.ok) return apiError(res, 403, hit.reason);
    try {
      const { readFileSync, statSync } = await import('node:fs');
      const st = statSync(hit.path);
      if (!st.isFile()) return apiError(res, 400, '不是文件');
      if (st.size > 1024 * 1024) return apiError(res, 413, '文件超过 1MB，请用 Read 工具分段读取');
      return json(res, 200, { path: hit.path, size: st.size, content: readFileSync(hit.path, 'utf8') });
    } catch (e) { return apiError(res, 400, `读取失败: ${e.message}`); }
  }
  if (p === '/workspace/mcp' && method === 'GET') return json(res, 200, []);
  if (p === '/workspace/skill' && method === 'GET') return json(res, 200, []);

  // ---------- 定时任务（Schedule） ----------
  // GET    /schedule/                 列表
  // POST   /schedule/                 创建（校验 agent / cron / 模型配置）
  // PATCH  /schedule/:id              更新（启用/停用、改名、改 cron 等）
  // DELETE /schedule/:id              删除
  // GET    /schedule/:id/sessions     该任务触发产生的会话（审计用，扁平记录）
  if (p === '/schedule/' && method === 'GET') {
    const schedules = listSchedules();
    return json(res, 200, { schedules, total: schedules.length });
  }
  if (p === '/schedule/' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name?.trim()) return apiError(res, 422, 'name 不能为空');
    if (!body.agent_id) return apiError(res, 422, 'agent_id 不能为空');
    if (!getAgent(body.agent_id)) return apiError(res, 404, 'agent 不存在');
    if (!body.cron_expression?.trim()) return apiError(res, 422, 'cron_expression 不能为空');
    try { validateCron(body.cron_expression); }
    catch (e) { return apiError(res, 400, e?.message || String(e)); }
    if (!body.chat_model_config || !body.chat_model_config.model) {
      return apiError(res, 422, 'chat_model_config.model 不能为空');
    }
    const record = createSchedule(body);
    return json(res, 200, { schedule_id: record.id });
  }
  if ((m = p.match(/^\/schedule\/([\w-]+)\/sessions$/)) && method === 'GET') {
    // 任务删除后历史也被清空；查不到记录时返回空列表即可（前端容错）
    const runs = listRuns(m[1]);
    const sessions = runs
      .map((r) => (r.session_id ? loadSessionRecord(r.session_id) : null))
      .filter(Boolean);
    return json(res, 200, { sessions, total: sessions.length });
  }
  if ((m = p.match(/^\/schedule\/([\w-]+)$/)) && method === 'PATCH') {
    const body = await readBody(req);
    if (body.cron_expression !== undefined) {
      try { validateCron(body.cron_expression); }
      catch (e) { return apiError(res, 400, e?.message || String(e)); }
    }
    const record = updateSchedule(m[1], body);
    if (!record) return apiError(res, 404, '定时任务不存在');
    return json(res, 200, record);
  }
  if ((m = p.match(/^\/schedule\/([\w-]+)$/)) && method === 'DELETE') {
    deleteSchedule(m[1]);
    return json(res, 200, { status: 'ok' });
  }
  if (p === '/channels/types' || p === '/channels/' || p.startsWith('/channels/')) {
    if (p === '/channels/types') return json(res, 200, []);
    if (p === '/channels/') return json(res, 200, []);
    return apiError(res, 404, 'not found');
  }
  // /hub/mcp —— MCP 市场卡片的空态（尚未接上游）
  if (p === '/hub/mcp' && method === 'GET') return json(res, 200, []);

  // ---------- Skill hubs（多源，按 hubId 分发到各自适配器） ----------
  // hub 列表：前端侧栏的来源列表就是它。上游挂了也照常返回，否则用户进不去页面。
  if (p === '/hub/skill' && method === 'GET') {
    return json(res, 200, HUBS.map(hubView));
  }

  // /hub/skill/:hubId/categories —— 分类清单，供前端渲染分类筛选
  {
    const m = /^\/hub\/skill\/([^/]+)\/categories$/.exec(p);
    if (m && method === 'GET') {
      const provider = providerFor(m[1]);
      if (!provider) return apiError(res, 404, `未知的 skill 来源: ${m[1]}`);
      if (typeof provider.listCategories !== 'function') return json(res, 200, []);
      try {
        return json(res, 200, await provider.listCategories(m[1]));
      } catch (e) {
        return json(res, 200, []); // 分类拿不到不该挡住浏览
      }
    }
  }

  // /hub/skill/:hubId/resolve?task=&agent= —— 按任务推荐（仅支持的源）
  {
    const m = /^\/hub\/skill\/([^/]+)\/resolve$/.exec(p);
    if (m && method === 'GET') {
      const provider = providerFor(m[1]);
      if (!provider) return apiError(res, 404, `未知的 skill 来源: ${m[1]}`);
      if (typeof provider.resolveTask !== 'function') {
        return apiError(res, 404, `该来源不支持按任务匹配`);
      }
      const task = (q.task || '').trim();
      if (!task) return apiError(res, 422, 'task 不能为空');
      try {
        return json(res, 200, await provider.resolveTask(m[1], task, q.agent || 'codex'));
      } catch (e) {
        return apiError(res, e.status === 504 ? 502 : (e.status || 502), e.message || 'resolve failed');
      }
    }
  }

  // /hub/skill/:hubId/cards?q=&category=&cursor=&limit=
  {
    const m = /^\/hub\/skill\/([^/]+)\/cards$/.exec(p);
    if (m && method === 'GET') {
      const hubId = m[1];
      const provider = providerFor(hubId);
      if (!provider) return apiError(res, 404, `未知的 skill 来源: ${hubId}`);
      try {
        const page = await provider.listSkillCards(hubId, {
          // 前端用 q；公开文档里叫 keyword，两个都收。
          q: q.q || q.keyword || null,
          category: q.category || null,
          cursor: q.cursor || null,
          limit: q.limit || 20,
        });
        return json(res, 200, page);
      } catch (e) {
        if (e instanceof HubError) {
          return json(res, e.status === 504 ? 502 : (e.status === 404 ? 404 : 502),
            { detail: e.message, cards: [], next_cursor: null });
        }
        return json(res, 502, { detail: 'hub cards fetch failed', cards: [], next_cursor: null });
      }
    }
  }

  // /hub/skill/:hubId/cards/:cardId  —— 详情
  {
    const m = /^\/hub\/skill\/([^/]+)\/cards\/([^/]+)$/.exec(p);
    if (m && method === 'GET') {
      const provider = providerFor(m[1]);
      if (!provider) return apiError(res, 404, `未知的 skill 来源: ${m[1]}`);
      try {
        const card = await provider.getSkillCard(m[1], decodeURIComponent(m[2]));
        if (!card) return apiError(res, 404, 'card not found');
        return json(res, 200, card);
      } catch (e) {
        if (e instanceof HubError) {
          return apiError(res, e.status === 504 ? 502 : (e.status === 404 ? 404 : 502), e.message);
        }
        return apiError(res, 502, 'hub card fetch failed');
      }
    }
  }

  // /hub/skill/:hubId/cards/:cardId/install  —— install (POST or GET 兼容)
  {
    const m = /^\/hub\/skill\/([^/]+)\/cards\/([^/]+)\/install$/.exec(p);
    if (m && (method === 'POST' || method === 'GET')) {
      const hubId = m[1];
      const cardId = decodeURIComponent(m[2]);
      const provider = providerFor(hubId);
      if (!provider) return apiError(res, 404, `未知的 skill 来源: ${hubId}`);
      try {
        // 先拿卡片 detail（install 需要完整信息以落正文）
        const card = await provider.getSkillCard(hubId, cardId);
        if (!card) return apiError(res, 404, 'card not found');
        // 同一 card 已安装？直接返已有
        const existing = findSkillByCardId(card.hub_id, card.id);
        if (existing) {
          return json(res, 200, existing);
        }
        // 自定义 name（用户提供则用；否则用 card.name）
        let customName = null;
        try {
          if (method === 'POST') {
            const body = await readBody(req);
            if (typeof body?.name === 'string') customName = body.name.trim() || null;
          } else if (q.name) {
            customName = String(q.name).trim() || null;
          }
        } catch { /* body 解析失败无视 */ }

        const skill = await installSkill({
          hub_id: card.hub_id,
          card_id: card.id,
          name: customName || card.name,
          display_name: card.display_name,
          description: card.description,
          description_zh: card.description_zh,
          tags: card.tags,
          author: card.author,
          icon_url: card.icon_url,
          url: card.url,
          version: card.version,
          fetchMarkdown: async () => {
            const base = card.markdown || '';
            // 上游若有"安装交接单"（OpenAgentSkill），并进正文 —— 模型因此知道
            // 这个技能实际怎么装、装完是什么形态。
            if (typeof provider.getInstallNotes === 'function') {
              const notes = await provider.getInstallNotes(hubId, cardId);
              if (notes) return `${base}\n\n---\n\n${notes}`;
            }
            if (base) return base;
            const detail = await provider.getSkillCard(hubId, cardId);
            return detail?.markdown || '';
          },
        });
        return json(res, 200, skill);
      } catch (e) {
        if (e?.code === 'NAME_CONFLICT') {
          return json(res, 409, { detail: '同名 skill 已存在，请换名', existing: e.existing });
        }
        if (e instanceof HubError) {
          return apiError(res, e.status === 504 ? 502 : (e.status === 404 ? 404 : 502), e.message);
        }
        return apiError(res, 500, 'install failed: ' + (e?.message || 'unknown'));
      }
    }
  }

// ---------- 用户 library：/skill ----------
  // /skill（GET）—— 硬导航走 SPA，XHR/fetch 走 JSON 列表
  if (p === '/skill' && method === 'GET' && isPageNavigation(req)) return serveStatic(p, res);
  if (p === '/skill' && method === 'GET') {
    return json(res, 200, listSkills());
  }

  // /skill/:id（GET）—— 单个详情（带 markdown）
  {
    const m = /^\/skill\/([^/]+)$/.exec(p);
    if (m && method === 'GET') {
      const skill = getSkill(m[1]);
      if (!skill) return apiError(res, 404, 'skill not found');
      return json(res, 200, skill);
    }
  }

  // 本地导入技能：路径来自用户在原生文件夹对话框里亲手选的目录（Electron 壳层桥）
  if (p === '/skill/import-local' && method === 'POST') {
    try {
      const body = await readBody(req);
      const skill = importSkillFromLocal({ path: body?.path });
      return json(res, 200, { status: 'ok', skill });
    } catch (e) {
      return apiError(res, e?.code === 'NAME_CONFLICT' ? 409 : 422, e?.message || String(e));
    }
  }
  // /skill/:id/markdown（GET）—— 单独拿 SKILL.md（按需 load；用于 chat 注入 LLM）
  {
    const m = /^\/skill\/([^/]+)\/markdown$/.exec(p);
    if (m && method === 'GET') {
      const id = m[1];
      const md = await loadSkillMarkdown(id, async () => {
        const skill = getSkill(id);
        if (!skill?.hub_id || !skill?.card_id) return '';
        try {
          const card = await getSkillCard(skill.hub_id, skill.card_id);
          return card?.markdown || '';
        } catch {
          return '';
        }
      });
      if (md == null) return apiError(res, 404, 'skill not found');
      return json(res, 200, { markdown: md });
    }
  }

  // /skill/:id（DELETE）—— 卸载
  {
    const m = /^\/skill\/([^/]+)$/.exec(p);
    if (m && method === 'DELETE') {
      const ok = deleteSkill(m[1]);
      if (!ok) return apiError(res, 404, 'skill not found');
      return json(res, 200, { ok: true });
    }
  }
  // /mcp（GET）是页面路由 + 列表 API 重叠：
  // 硬导航（地址栏 / Cmd+R）必须落到 SPA 的 MCPHubPage。
  // /skill 已在上方分支处理（带 isPageNavigation 判断）。
  // MCP 服务器实时探测：逐台联系拉 tools/list（各自短超时），设置页展示用
  if (p === '/mcp/servers' && method === 'GET') {
    const cfg0 = loadConfig();
    const status = await mcpStatus(cfg0, { timeoutMs: 8000 });
    return json(res, 200, { servers: status });
  }
  // ── MCP 工坊：服务器 CRUD + 探测 + 工具试调 + 预设模板 ──
  if (p === '/mcp-workshop/servers' && method === 'GET') {
    return json(res, 200, { servers: mcpListServers() });
  }
  if (p === '/mcp-workshop/templates' && method === 'GET') {
    return json(res, 200, { templates: mcpListTemplates() });
  }
  if (p === '/mcp-workshop/servers' && method === 'POST') {
    const body = await readBody(req);
    try {
      const r = mcpAddServer(body.name, { command: body.command, args: body.args, env: body.env });
      return json(res, 200, r);
    } catch (e) { return apiError(res, 400, e.message); }
  }
  if ((m = p.match(/^\/mcp-workshop\/servers\/([\w-]+)$/)) && method === 'PATCH') {
    const body = await readBody(req);
    try {
      const r = mcpUpdateServer(m[1], body);
      return json(res, 200, r);
    } catch (e) { return apiError(res, 404, e.message); }
  }
  if ((m = p.match(/^\/mcp-workshop\/servers\/([\w-]+)$/)) && method === 'DELETE') {
    try { mcpRemoveServer(m[1]); return json(res, 200, { status: 'ok' }); }
    catch (e) { return apiError(res, 404, e.message); }
  }
  if ((m = p.match(/^\/mcp-workshop\/servers\/([\w-]+)\/probe$/)) && method === 'POST') {
    try {
      const r = await mcpProbeServer(m[1]);
      return json(res, 200, r);
    } catch (e) { return apiError(res, 404, e.message); }
  }
  if ((m = p.match(/^\/mcp-workshop\/servers\/([\w-]+)\/call$/)) && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await mcpCallTool(m[1], body.tool, body.args);
      return json(res, 200, { result });
    } catch (e) { return apiError(res, 400, e.message); }
  }
  if (p === '/mcp') {
    if (method === 'GET' && isPageNavigation(req)) return serveStatic(p, res);
    return json(res, 200, []);
  }
  if (p === '/knowledge_bases/' || p === '/knowledge_bases') {
    return json(res, 200, { knowledge_bases: [], total: 0, page: 1, page_size: 30 });
  }
  if (p === '/knowledge_bases/middleware/parameters_schema') return json(res, 200, { parameter_schema: {} });

  // ---------- 最终兜底 ----------
  // "页面导航"（浏览器地址栏 / Cmd+R）才回 SPA 页面（index.html）。
  // fetch/XHR 只带 Sec-Fetch-Dest: empty 或 Accept 不含 text/html——走到这里说明是
  // 未被任何 handler 匹配的 API 调用（典型：旧进程缺新端点），必须回 404 JSON，
  // 否则前端 res.json() 会因 "<!doctype" 抛出无从定位的 SyntaxError。
  if (method === 'GET' && !/\.[a-zA-Z0-9]+$/.test(p) && isPageNavigation(req)) {
    return serveStatic(p, res);
  }
  apiError(res, 404, `接口不存在: ${method} ${p}`);
}

// 判断请求是否为页面导航（要 HTML 文档），而非 fetch/XHR API 调用
function isPageNavigation(req) {
  const dest = req.headers['sec-fetch-dest'];
  if (dest !== undefined) return dest === 'document';
  // 无 Sec-Fetch 头的客户端：看 Accept
  return String(req.headers['accept'] || '').includes('text/html');
}

/**
 * hub 元信息 → 前端视图。补上能力开关，避免前端硬编码"哪个源有任务匹配"。
 */
function hubView(hub) {
  const provider = providerFor(hub.hub_id);
  return {
    ...hub,
    // 能力由"适配器有没有实现这个函数"决定，不靠 hub 元信息手写 —— 少一处
    // 可能写错的地方，加新源时也不必记得同步。
    supports_categories: typeof provider?.listCategories === 'function',
    supports_resolve: typeof provider?.resolveTask === 'function',
  };
}

/** 模型支持视觉时暴露的图片 MIME 清单（前端据此开启/关闭附件按钮） */
const VISION_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** 按模型名 + 显式 vision 位生成 input_types（与 model.js detectVision 同规则） */
function inputTypesFor(modelName, visionFlag) {
  const vision = detectVision({ model: modelName ?? '', vision: visionFlag ?? null });
  return vision ? ['text', ...VISION_INPUT_TYPES] : ['text'];
}

function modelCards(cfg) {
  const names = new Set([cfg.model, ...(cfg.models || [])]);
  names.delete('');
  return [...names].map((name) => ({
    type: 'chat_model', name, label: name, status: 'active', deprecated_at: null,
    input_types: inputTypesFor(name, cfg.vision), output_types: ['text'],
    context_size: 128000, output_size: 16384,
    parameter_schema: {
      type: 'object',
      properties: { temperature: { type: 'number', title: 'Temperature', minimum: 0, maximum: 2 } }
    },
    parameters_overrides: {}
  }));
}

async function serveStatic(path, res) {
  let file = path === '/' ? '/index.html' : path;
  const full = join(DIST_DIR, file);
  if (!full.startsWith(DIST_DIR)) return apiError(res, 403, 'forbidden');
  try {
    const st = await stat(full);
    if (st.isDirectory()) throw new Error('dir');
    const data = await readFile(full);
    const isHtml = (MIME[extname(full)] || '').startsWith('text/html');
    res.writeHead(200, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
      ...(isHtml ? { 'cache-control': 'no-cache' } : {})
    });
    return res.end(data);
  } catch {
    // SPA fallback
    try {
      const data = await readFile(join(DIST_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(data);
    } catch {
      return apiError(res, 404, '前端未构建：请先在 packages/desktop/frontend 执行 npm run build');
    }
  }
}

// CLI 直跑入口：node asapi/server.js [port]
if (process.argv[1] && process.argv[1].endsWith('asapi/server.js')) {
  const port = Number(process.argv[2] || 3210);
  startASAPIServer({ port }).then((srv) => {
    console.log(`CoCode ASAPI 服务已启动: http://127.0.0.1:${srv.address().port}`);
  });
}
