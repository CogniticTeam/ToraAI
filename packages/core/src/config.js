// CoCode 配置管理：~/.cocode/config.json + 环境变量覆盖
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDirectory } from './legacy-migration.js';

// 数据根目录。COCODE_HOME 可整体重定向（测试、多 profile、
// 便携模式都靠它）——**测试必须用它**，否则 rmSync 会把用户真实的
// ~/.cocode 配置/会话/技能库删掉。
export const COCODE_DIR = resolveDataDirectory();
export const CONFIG_PATH = join(COCODE_DIR, 'config.json');
export const SESSIONS_DIR = join(COCODE_DIR, 'sessions');

export const DEFAULT_CONFIG = {
  // 自接入模型：任何 OpenAI 兼容接口均可（OpenAI/DeepSeek/智谱/Moonshot/Ollama/vLLM…）
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  // 低 token 策略参数
  maxTokensBudget: 24000,      // 上下文 token 预算（估算值），超过即触发驱逐/压缩
  toolOutputLimit: 6000,       // 单个工具输出最大字符数（超出截断）
  maxTurns: 40,                // 单次任务最大 Agent 循环轮数
  temperature: null,           // null = 不发送
  systemPrompt: null,          // null = 使用内置默认（紧凑型）
  // ---- 安全 ----
  // 路径沙箱默认只允许工作目录；确需额外目录时在这里显式放行（绝对路径数组）
  allowedRoots: [],
  // 未选择工作目录时的默认可编辑范围：
  //   false（默认）= 仅允许对话/联网；文件、终端等本地工具必须先选择目录。
  //   true = 用户明确选择扩展到家目录（仍受 allowedRoots 与权限模式约束）。
  defaultScopeFullDisk: false,
  // bash 是否使用长驻 shell（cd/export/source 会保留）。默认开；个别环境下可关。
  persistentShell: true,
  // ---- 项目上下文注入 ----
  injectProjectContext: true,  // 自动注入 COCODE.md / AGENTS.md + git 状态
  instructionMaxChars: 6000,   // 单个约定文件注入上限
  repoMapInject: true,         // 是否把仓库骨架注入系统提示词
  repoMapMaxChars: 2500,       // 注入的骨架文本上限
  repoMapThreshold: 25,        // 代码文件数低于此值不注入（小仓库自己 Glob 更便宜）
  // ---- 权限 ----
  // 用户权限规则（"以后都别问我"）：{tool_name, rule_content, behavior: allow|deny|ask, source}
  permissionRules: [],
  // ---- 能力 ----
  vision: null,                // null = 按模型名自动判断；true/false 强制
  forceReact: false,           // true = 始终用文本 ReAct（调试用）
  webTimeout: 20000,           // 联网工具超时（毫秒）
  // ---- 检查点与回滚 ----
  checkpointEnabled: true,     // 每轮写/执行前对工作目录做快照
  checkpointKeepTurns: 10,     // 每个会话保留的检查点数
  // ---- 钩子（~/.cocode/hooks.json 与 <cwd>/.cocode/hooks.json）----
  hooksEnabled: true,          // 关掉就完全不跑钩子
  // 项目级钩子来自仓库内容，clone 一个仓库就执行其中的命令 = 任意代码执行，
  // 所以默认**不信任**。用户确认过某个仓库之后可以把它加到 trustProjectHooksFor。
  trustProjectHooks: false,
  trustProjectHooksFor: [],    // 信任项目钩子的工作目录列表（绝对路径）
  // ---- 变更感知 ----
  changesAware: true,          // 把「最近改动的文件」注入系统提示词
  changesLimit: 12,
  // ---- LSP（可选）----
  // 形如 { ".ts": {"command":"typescript-language-server","args":["--stdio"]} }
  // 不配则 Lsp 工具用本地符号索引（够用，但没有类型信息）
  lspServers: {},
  // 桌面端模型选择器可选模型（openai_compatible 全兼容）
  models: ['gpt-4o-mini', 'glm-4.6', 'moonshot-v1-32k'],
  // 多模型列表（设置窗口"模型"板块）：[{id, provider, label, model, baseURL, apiKey, enabled}]
  // 第一条 enabled 的模型会同步到上方 baseURL/apiKey/model 作为生效配置
  modelList: [],
  // ---- 反思返工循环（Critic Self-Review）----
  // 默认关（每轮多一次模型调用 = 双倍 token 成本）；Agent.data.review_config 可覆盖。
  // 桌面端把它暴露为每个 Agent 的「自我复核」，避免把成本强加给纯问答会话。
  review: {
    enabled: false,
    max_rounds: 2,
    min_turns: 3,
    checklist: [
      '所有工具调用都成功（ok=true）还是有被拒绝/失败的？',
      '工具调用序列与任务目标匹配吗？有没有多余或遗漏的步骤？',
      '最终答复与任务目标直接对应吗？',
      '如果做了代码修改，有没有考虑构建/类型检查/测试？'
    ]
  },
  // ---- 结构化输出（JSON Schema 约束）----
  // 空 = 正常自由文本回复；Agent.data.output_schema 可覆盖
  output_schema: null,
  output_schema_max_rounds: 2
};

export function loadConfig() {
  let file = {};
  if (existsSync(CONFIG_PATH)) {
    try { file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 损坏则忽略 */ }
  }
  const cfg = { ...DEFAULT_CONFIG, ...file };
  // COCODE_* 环境变量优先于配置文件。
  const envBase = process.env.COCODE_BASE_URL;
  const envKey = process.env.COCODE_API_KEY;
  const envModel = process.env.COCODE_MODEL;
  if (envBase) cfg.baseURL = envBase;
  if (envKey) cfg.apiKey = envKey;
  if (envModel) cfg.model = envModel;
  else if (process.env.OPENAI_BASE_URL && !file.baseURL) cfg.baseURL = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_API_KEY && !file.apiKey && !envKey) cfg.apiKey = process.env.OPENAI_API_KEY;
  return cfg;
}

export function saveConfig(patch) {
  const cur = loadConfig();
  const clean = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v !== undefined) clean[k] = v; // 允许显式传 undefined 表示"不修改"
  }
  const next = { ...cur, ...clean };
  mkdirSync(COCODE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// 把 modelList 中第一条启用的模型同步为生效配置（baseURL/apiKey/model）
// 在模型列表增删改/切换开关后调用，保证 runAgent 直接读主字段即可
export function syncEffectiveModel() {
  const cfg = loadConfig();
  const active = (Array.isArray(cfg.modelList) ? cfg.modelList : []).find(
    (m) => m.enabled && !m.isOfficial && !String(m.baseURL || '').includes('/official/v1'),
  );
  if (active) {
    return saveConfig({ baseURL: active.baseURL, apiKey: active.apiKey, model: active.model });
  }
  return cfg;
}
