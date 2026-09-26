// CoCode Agent 循环：流式输出 + 工具调用 + 权限 HITL + 低 token 上下文治理
// 事件流（消费者可完整还原会话）：
//   text-delta        {text}            流式文本增量
//   tool-start        {id,name,args}    工具开始
//   tool-result       {id,name,ok,result,durationMs}
//   require-confirm   {id,name,args,suggestedRules,message}  权限询问（等用户回复）
//   confirm-resolved  {id,confirmed}    用户已回复
//   ask-user          {id,questions}    AskUserQuestion 提问（等用户作答，由通道 emit）
//   rule-added        {rule}            用户选择"以后都这样"，规则已固化
//   checkpoint        {turn,fileCount}  本轮改动前的快照已建立
//   compact           {evicted,compacted,tokensBefore,tokensAfter,budget}
//   turn-end          {turn,usage}      一轮模型调用结束
//   mode-changed      {mode:'react'|'tools', reason}  能力降级
//   hook              {event,ran,decision,notices}    钩子执行结果（含未信任项目钩子的提示）
//   done              {reason,totalUsage}  结束（completed/aborted/max-turns/blocked/error）
//
// 钩子（~/.cocode/hooks.json 与 <cwd>/.cocode/hooks.json）在四个点介入：
//   UserPromptSubmit 组装系统提示词之前（可注入上下文，或直接拦下整轮）
//   PreToolUse       权限决策之前（deny 优先于任何权限放行，可改写参数、强制询问）
//   PostToolUse      工具执行之后（可补充上下文，或标记这次结果不可接受）
//   Stop             正常结束时（用于通知、清理、写自己的日志）
import { createClient, chatCompletion, markToolUnsupported, SYSTEM_PROMPT } from './model.js';
import { builtinTools, canonicalToolName, toolCategory } from './tools/builtin.js';
import { evictToolOutputs, compactMessages, estimateMessagesTokens, contentToText } from './context.js';
import { buildSystemPrompt, loadProjectContext } from './prompt.js';
import { loadMemoryConfig, renderMemoryContext, MEMORY_GUIDE } from './asapi/memory.js';
import { createRoots, realpathAllowMissing } from './security.js';
import { homedir } from 'node:os';
import { buildMcpTools } from './tools/mcp.js';
import { subagentTools } from './tools/subagent.js';
import { teamTools } from './tools/team.js';
import { snapshot as checkpointSnapshot } from './tools/checkpoint.js';
import { disposeAllShells } from './tools/shell.js';
import { parseReactAction } from './react.js';
import { runHooks } from './hooks.js';

// ---------------------------------------------------------------- 反思返工循环（Critic Self-Review）
//
// 在 Agent 正常完成（非 abort/blocked/error/max-turns）之后，
// 用同模型再发一次 chatCompletion，让它自我审查刚跑完的轨迹。
// 不达标就把 Critic 反馈喂回去，让 Agent 再跑一轮 finish。
// 默认关（双倍 token 成本）；cfg.review.enabled 或 Agent.data.review 开时启用。

/** 统计 messages 里有多少条 tool_call 产生的实际调用（含并发多调用） */
function countToolCalls(messages) {
  let n = 0;
  for (const m of messages) {
    if (Array.isArray(m.tool_calls)) n += m.tool_calls.length;
  }
  return n;
}

/** 是否真的执行过会改变工作区或外部状态的动作。 */
function hasMutatingToolCall(messages) {
  return messages.some((m) => (m.tool_calls || []).some((call) => {
    let args = {};
    try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* ignore */ }
    return ['write', 'execute'].includes(toolCategory(call.function?.name, args));
  }));
}

/** 把 messages 里对 Critic 有用的部分挑出来，转成可读文本 */
function serializeMessagesForCritic(messages) {
  const lines = [];
  let turn = 0;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const txt = String(m.content ?? '').slice(0, 800);
      lines.push(`  [tool-result] ${m.tool_name || '(unknown)'} → ${m.tool_state === 'error' ? 'FAIL' : 'ok'}\n${txt}`);
      continue;
    }
    const tc = m.tool_calls;
    if (Array.isArray(tc) && tc.length) {
      turn++;
      lines.push(`\n─── 轮次 ${turn} ───`);
      for (const c of tc) {
        const name = c.function?.name || '(unknown)';
        const args = c.function?.arguments || '{}';
        const argsShort = String(args).slice(0, 200);
        lines.push(`  [call] ${name}(${argsShort})`);
      }
      continue;
    }
    if (m.role === 'assistant' && m.content) {
      const txt = contentToText(m.content).slice(0, 4000);
      lines.push(`\n[最终答复]\n${txt}`);
    }
  }
  return lines.join('\n');
}

/** 构造 Critic Prompt（让模型自我审查） */
function buildCriticMessages(messages, checklist) {
  const trajectory = serializeMessagesForCritic(messages);
  const checklistText = checklist.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const sys = `你是一个严格的 AI Agent 审查者。下面是另一个 AI Agent 刚刚完成的任务执行轨迹 —— 它接到了一个用户请求，然后调了一系列工具，最后给出了答复。

请按以下清单逐项审查，返回一段**纯 JSON**（不要 Markdown 代码块、不要额外文字）：
{
  "passed": true 或 false,
  "issues": ["问题1", "问题2"],        // 仅当 passed=false 时填，最多 5 条
  "reason": "一句话总体判断"
}

审查维度：
${checklistText}

如果 agent 的产出在以上维度都 OK，返回 passed=true。有任何一项明显不通过，返回 passed=false + 具体问题列表。`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `Agent 的执行轨迹如下：\n---\n${trajectory}\n---\n\n只返回 JSON，不要额外解释。` }
  ];
}

/** 从 Critic 输出里解析 JSON（和 parseReactAction 同范式） */
function parseCriticResult(text) {
  if (!text) return { passed: false, issues: ['Critic 无输出'], reason: 'empty' };
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text))) {
    try { return tryParseCritic(m[1]); } catch { /* try next */ }
  }
  let idx = text.indexOf('{');
  while (idx >= 0) {
    const balanced = __sliceBalancedJson(text, idx);
    if (balanced) {
      try { return tryParseCritic(balanced); } catch { /* try next */ }
    }
    idx = text.indexOf('{', idx + 1);
  }
  return { passed: false, issues: [String(text).slice(0, 500)], reason: 'Critic 输出不是合法 JSON' };
}

function tryParseCritic(raw) {
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('not object');
  return {
    passed: Boolean(obj.passed),
    issues: Array.isArray(obj.issues) ? obj.issues.slice(0, 5).map(String) : [],
    reason: String(obj.reason ?? '')
  };
}

/** 复用 react.js 的平衡括号解析 */
import { __sliceBalancedJson } from './react.js';
import { validateAgainstSchema } from './tools/schema-validator.js';

const CATEGORY_LABEL = { read: '只读', write: '写入', execute: '执行' };

// ---------------------------------------------------------------- 权限

/** 用户规则表：{tool_name, rule_content, behavior, source} */
export function matchRule(rule, toolName, args = {}) {
  if (!rule || typeof rule !== 'object') return false;
  const want = canonicalToolName(toolName);
  if (canonicalToolName(rule.tool_name) !== want) return false;
  const content = rule.rule_content;
  if (content == null || content === '') return true;
  const c = String(content);
  switch (want) {
    case 'Bash': {
      const cmd = String(args.command ?? '');
      return cmd.includes(c);
    }
    case 'Read': case 'Write': case 'Edit': {
      const p = String(args.path ?? '');
      if (p === c || p.startsWith(c.replace(/\*+$/, ''))) return true;
      return globLikeMatch(c, p);
    }
    case 'Git':
      return `git ${args.subcommand ?? ''}`.includes(c) || String(args.subcommand ?? '') === c;
    default:
      return JSON.stringify(args ?? {}).includes(c);
  }
}

/** 极简 glob（只用得到 `*` 和 `**`） */
function globLikeMatch(pattern, value) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  try { return new RegExp(`^${re}$`).test(value); } catch { return false; }
}

/** default 模式下可自动放行的只读 bash 命令（与 SDK 的 read-only 自动放行对齐） */
const READONLY_BASH_CMDS = new Set([
  'ls', 'cat', 'head', 'tail', 'pwd', 'echo', 'wc', 'file', 'stat', 'du', 'df',
  'which', 'whoami', 'date', 'tree', 'basename', 'dirname', 'realpath', 'type',
  'uname', 'hostname', 'grep', 'id', 'ps', 'lsof', 'uptime', 'who', 'arch',
  'sw_vers', 'system_profiler', 'mdfind',
  'printenv-never' // 占位：printenv/env 故意不放行（env 可以前缀执行任意命令）
]);
const SHELL_META_RE = /[;&|><`$\n(){}\\]/;
// 复合命令分隔符：; && || | &（丢弃型重定向先剥离，2>&1 不会被误拆）
const SEGMENT_SPLIT_RE = /&&|\|\||[;|&]/;
// 只剥"丢弃型"重定向（目标 /dev/null 或 fd 复制）；写真实文件的 > f 保留，靠元字符检测拒绝
const DISCARD_REDIRECT_RE = /\s*\d?>>?\s*\/dev\/null\b|\s*\d?>&\d\b|\s*&>\s*\/dev\/null\b/g;
// 命令替换 / 变量展开 / 子 shell / 行续接：整个命令层面快速失败
const SUBST_RE = /`|\$|\(|\\|\n/;

function isReadOnlySegment(seg) {
  seg = seg.trim();
  if (!seg) return false;
  const stripped = seg.replace(DISCARD_REDIRECT_RE, ' ').trim();
  if (!stripped) return false;
  // 剥完丢弃重定向后仍有元字符 → 写文件（> out.txt）或未识别结构，交给确认卡
  if (SHELL_META_RE.test(stripped)) return false;
  const tokens = stripped.split(/\s+/);
  const head = tokens[0];
  // 前缀环境变量赋值（FOO=bar cmd）改变执行环境，不放行
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return false;
  if (head === 'git') {
    return ['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'remote', 'tag', 'stash', 'blame', 'grep', 'ls-files', 'describe']
      .includes(tokens[1] ?? '');
  }
  if (head === 'node' || head === 'npm' || head === 'pnpm' || head === 'yarn') {
    return ['-v', '--version', 'ls', 'list', 'why', 'outdated'].includes(tokens[1] ?? '');
  }
  // macOS 系统查询：只放行显式只读子命令（defaults write / sysctl -w 严格排除）
  if (head === 'defaults') return tokens[1] === 'read';
  if (head === 'pmset') return tokens[1] === '-g';
  if (head === 'launchctl') return tokens[1] === 'list';
  if (head === 'ipconfig') return ['getifaddr', 'getpacket'].includes(tokens[1] ?? '');
  if (head === 'sysctl') return !tokens.slice(1).some((t) => t === '-w' || t.includes('='));
  return READONLY_BASH_CMDS.has(head);
}

/**
 * default 模式只读 bash 判定：复合命令按 ; && || | & 分段，每段独立过白名单，
 * 全段只读才放行（如 `defaults read -g AppleLanguages 2>/dev/null; sw_vers -productVersion`）。
 * 丢弃型重定向（2>/dev/null、2>&1）先剥离；命令替换 $( )/反引号、前缀赋值一律不放行。
 */
export function isReadOnlyBash(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd || SUBST_RE.test(cmd)) return false;
  return cmd.split(SEGMENT_SPLIT_RE).every((s) => isReadOnlySegment(s));
}

function baseBehavior(mode, category) {
  switch (mode) {
    case 'bypass':
      return 'allow';
    case 'default':
      return category === 'read' ? 'allow' : 'ask';
    case 'accept_edits':
      return category === 'write' || category === 'read' ? 'allow' : 'ask';
    case 'explore':
      return category === 'read' ? 'allow' : 'deny';
    case 'dont_ask':
      // 无人值守：只放行不会触发询问的只读操作，其余一律拒绝
      return category === 'read' ? 'allow' : 'deny';
    default:
      // 配置损坏、拼写错误或第三方调用传入未知模式时，绝不能意外变成 bypass。
      // 退回 default 的最小权限语义：读放行，写/执行需要确认。
      return category === 'read' ? 'allow' : 'ask';
  }
}

/**
 * 权限决策：5 档 mode → 每个工具是 allow / ask / deny。
 *
 * 与 agentscope 的语义对齐：
 *  - 用户的 deny 规则在任何模式下都生效（bypass 也拦得住）；
 *  - 用户规则命中就不再是 ASK，所以 dont_ask 只把"本来要问的"降级为拒绝；
 *  - explore 是硬性只读契约，allow 规则也不能放行写类工具；
 *  - default 下会被询问，ask 通道缺失时（CLI 未接线）退化为可操作的拒绝文本。
 *
 * @param {string} mode
 * @param {string} toolName
 * @param {object} [args]
 * @param {Array}  [rules]
 * @returns {{behavior:'allow'|'deny'|'ask', category:string, reason:string, matchedRule?:object, suggestedRules:Array}}
 */
export function decidePermission(mode, toolName, args = {}, rules = []) {
  const name = canonicalToolName(toolName);
  const category = toolCategory(name, args);
  const list = Array.isArray(rules) ? rules : [];
  const hit = (behavior) => list.find((r) => r.behavior === behavior && matchRule(r, name, args));

  const denyRule = hit('deny');
  if (denyRule) {
    return { behavior: 'deny', category, reason: `命中用户禁用规则（${denyRule.rule_content || '全部'}）`, matchedRule: denyRule, suggestedRules: [] };
  }
  const askRule = hit('ask');
  if (askRule) {
    return mode === 'dont_ask'
      ? { behavior: 'deny', category, reason: '当前为 dont_ask 模式，询问被降级为拒绝', matchedRule: askRule, suggestedRules: [] }
      : { behavior: 'ask', category, reason: `命中用户询问规则（${askRule.rule_content || '全部'}）`, matchedRule: askRule, suggestedRules: [] };
  }
  let behavior = baseBehavior(mode, category);
  // default 模式的只读 bash 自动放行（对齐 SDK：ls / git status 这类不该问）
  if (behavior === 'ask' && name === 'Bash' && mode === 'default' && isReadOnlyBash(args.command)) {
    behavior = 'allow';
  }
  const allowRule = hit('allow');
  if (behavior !== 'allow' && allowRule && mode !== 'explore') {
    behavior = 'allow';
    const out = { behavior, category, reason: `命中用户放行规则（${allowRule.rule_content || '全部'}）`, matchedRule: allowRule, suggestedRules: [] };
    return out;
  }
  return {
    behavior,
    category,
    reason: `当前模式 "${mode}" 对${CATEGORY_LABEL[category] || '此类'}工具的处理是 ${behavior}`,
    suggestedRules: behavior === 'ask' ? buildSuggestedRules(name, args) : []
  };
}

/** 为确认卡片生成"以后都别问我"的候选规则 */
export function buildSuggestedRules(toolName, args = {}) {
  const name = canonicalToolName(toolName);
  const mk = (content) => ({ tool_name: name, rule_content: content, behavior: 'allow', source: 'userSettings' });
  switch (name) {
    case 'Bash': {
      const cmd = String(args.command ?? '').trim();
      if (!cmd || SHELL_META_RE.test(cmd.replace(/^\s*/, '').split(/\s+/).slice(0, 2).join(' ')) ) {
        // 含管道/重定向等复合命令：只按首个词放行太危险，退化为"仅本次"
        const head = cmd.split(/\s+/)[0];
        return head && !SHELL_META_RE.test(head) ? [mk(head)] : [];
      }
      const tokens = cmd.split(/\s+/);
      const keep = tokens.length >= 2 && !tokens[1].startsWith('-') && !SHELL_META_RE.test(tokens[1]) ? 2 : 1;
      return [mk(tokens.slice(0, keep).join(' '))];
    }
    case 'Read': case 'Write': case 'Edit': {
      const p = String(args.path ?? '');
      if (!p) return [];
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      return [mk(dir ? `${dir}/**` : p)];
    }
    case 'Git':
      return args.subcommand ? [mk(`git ${args.subcommand}`)] : [];
    case 'WebFetch': {
      try { return [mk(new URL(String(args.url)).host)]; } catch { return []; }
    }
    case 'Browser':
      // 浏览器的动作粒度太碎（open/click/type/press/back…），按主机或选择器
      // 固化意义不大 —— 想固化的人要的就是"让 AI 操控浏览器"。空 rule_content
      // 在 matchRule 里即"任意调用"，PermissionPanel 也按此渲染（任意调用），
      // 卡片文案由 ConfirmCard 回填为同样的说法。
      return [mk('')];
    default:
      return [];
  }
}

function denyMessage(toolName, mode, decision) {
  const name = canonicalToolName(toolName);
  const catLabel = CATEGORY_LABEL[decision?.category] || '此类';
  const hint = mode === 'accept_edits'
    ? 'accept_edits 自动放行写入类工具，但不会自动执行命令。要执行命令请切到 bypass，或在确认卡片里选"以后都允许"。'
    : mode === 'explore'
      ? 'explore 是只读模式（硬性契约）。要改文件请切到 accept_edits 或 bypass。'
      : mode === 'dont_ask'
        ? '当前为 dont_ask（无人值守）：只读操作放行，其余一律拒绝。如需写/执行请切到 default 或 bypass。'
        : '如需放行，请在确认卡片中选择"以后都允许"，或切换权限模式。';
  const why = decision?.reason ? `（${decision.reason}）` : '';
  return `权限策略拒绝：当前模式 "${mode}" 不允许${catLabel}工具 ${name}${why}。${hint}`;
}

/**
 * 被拦下时回给模型的话。
 * 关键是让模型分得清三种「不让做」：钩子拦的（用户写死的规则，别绕）、
 * 用户当场拒的（换个做法）、策略拦的（换权限模式）。混在一起它会反复重试。
 */
function hookOrPolicyMessage(g, toolName, mode) {
  const name = canonicalToolName(toolName);
  if (g.hookDenied) {
    return `钩子（PreToolUse）拒绝了 ${name}：${g.hookDenied}\n这是用户配置的硬规则，不要重试同样的调用；请换一种做法，或向用户说明为什么需要它。`;
  }
  if (g.noChannel) return NO_CHANNEL_MSG;
  if (g.userDenied) {
    return `用户拒绝执行 ${name}。请换一种做法，或向用户说明为什么需要这个操作；不要重复提交同样的调用。`;
  }
  return denyMessage(toolName, mode, g.decision);
}

const NO_CHANNEL_MSG = '权限询问无法送达用户：当前运行没有交互通道（CLI 未接线或前端未连接）。已按拒绝处理。如在 CLI 里，请使用支持确认的交互模式或切换权限模式。';

// ---------------------------------------------------------------- channel

// 简易异步队列：后台任务 push 事件，消费端 async 迭代拉取（真流式）
function channel() {
  const queue = [];
  let resolveWaiter = null;
  let ended = false;
  return {
    push(v) { queue.push(v); if (resolveWaiter) { const r = resolveWaiter; resolveWaiter = null; r(); } },
    end() { ended = true; if (resolveWaiter) { const r = resolveWaiter; resolveWaiter = null; r(); } },
    async *iterate() {
      while (true) {
        while (queue.length) yield queue.shift();
        if (ended) return;
        await new Promise((r) => { resolveWaiter = r; });
      }
    }
  };
}

/**
 * 运行 Agent。
 * @param {object} opts
 * @param {object} opts.cfg            配置（loadConfig() 的结果）
 * @param {Array}  opts.messages      会话消息数组（会被就地追加，调用方可持久化）
 * @param {string} [opts.cwd]          工具工作目录
 * @param {AbortSignal} [opts.signal]  中止信号
 * @param {Array}  [opts.extraTools]  额外工具定义 {name,description,parameters,execute}
 * @param {string} [opts.systemPrompt] 覆盖系统提示词
 * @param {number} [opts.maxTurns]     最大轮数
 * @param {Array}  [opts.permissionRules] 用户权限规则
 * @param {(info:object)=>Promise<{confirmed:boolean,rules?:Array}>} [opts.permissionAsk]
 *        权限询问通道。缺省时 ask 退化为 deny。抛错/abort 也按拒绝处理。
 * @param {(info:object)=>Promise<{answers:Array,note?:string,cancelled?:boolean}>} [opts.askUser]
 *        HITL 提问通道（AskUserQuestion 工具用）。缺省或 dont_ask 模式下，
 *        工具返回"无交互通道"兜底文案，不会卡住 run。
 * @param {(rule:object)=>void} [opts.onRuleAdded]  用户勾选"以后都允许"时的持久化回调
 * @param {{sessionId?:string, enabled?:boolean, keepTurns?:number}} [opts.checkpoint]
 * @param {(cwd:string)=>void} [opts.onCwdChange] 持久 shell 里 cd 之后回传新工作目录
 * @returns {AsyncGenerator} 事件流
 */
export function runAgent(opts) {
  const ch = channel();
  _runAgentImpl(opts, ch).catch((e) => {
    ch.push({ type: 'error', error: e?.message || String(e) });
    ch.push({ type: 'done', reason: 'error', totalUsage: null });
  }).finally(() => {
    ch.end();
    if (opts.disposeShellOnEnd !== false) disposeAllShells();
  });
  return ch.iterate();
}

async function _runAgentImpl(opts, ch) {
  const {
    cfg,
    messages,
    signal,
    extraTools = [],
    systemPrompt,
    maxTurns = cfg.maxTurns ?? 40,
    permissionRules = [],
    permissionAsk = null,
    onRuleAdded = null,
    checkpoint = null,
    onCwdChange = null,
    sessionState = null,
    spawnDepth = 0
  } = opts;

  // cwd 由调用方传入；默认不把本地工具作用域偷偷扩展到家目录。
  // 未选择目录时仍能正常对话/联网，本地文件、终端与相关工具会给出明确引导。
  // 仅用户显式设 cfg.defaultScopeFullDisk=true 才扩展至家目录。
  // 绝不回退到 process.cwd()——Electron 进程目录永远不是合法工作目录。
  // 只做 realpath 归一化，免得 /tmp 与 /private/tmp 这类符号链接差异让沙箱误判成"越界"。
  let cwd = opts.cwd || null;
  // 显式全盘模式下跳过整树扫描型开销（检查点快照 / 项目上下文注入），见下方两处守卫
  const defaultFullDisk = !cwd && cfg.defaultScopeFullDisk === true;
  if (defaultFullDisk) cwd = homedir();
  if (cwd) cwd = realpathAllowMissing(cwd);

  const client = createClient(cfg);
  // MCP 服务器工具：并行逐台拉 tools/list（各自短超时），挂了的服务器跳过
  // 并留一个"不可用"占位工具 —— 模型能看见原因，不会对着不存在的工具瞎猜。
  const mcpTools = await buildMcpTools(cfg);
  // spawnDepth > 0 表示这本身是一次子代理运行：不再注册 Subagent/TeamTools（防递归）。
  const allTools = [
    ...builtinTools,
    ...extraTools,
    ...mcpTools,
    ...(spawnDepth > 0 ? [] : subagentTools),
    ...(spawnDepth > 0 ? [] : teamTools)
  ];
  const toolDefs = allTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
  const toolMap = new Map();
  for (const t of allTools) {
    toolMap.set(t.name, t);
    toolMap.set(canonicalToolName(t.name).toLowerCase(), t); // 旧名/小写别名
  }

  // 调用方遗漏权限模式时采用 default，而非 bypass；桌面与 REPL 有确认通道，
  // 一次性 CLI 则仍在调用处明确选择 bypass，语义不被这个兜底悄悄改变。
  const permissionMode = opts.permissionMode ?? cfg.permissionMode ?? 'default';
  const rules = [...permissionRules];
  const sandboxRoots = cwd ? createRoots(cwd, cfg.allowedRoots) : [];
  const toolCtx = {
    cwd,
    sandboxRoots,
    toolOutputLimit: cfg.toolOutputLimit ?? 6000,
    persistentShell: cfg.persistentShell !== false,
    vision: client.vision,
    sessionId: checkpoint?.sessionId ?? opts.sessionId ?? null,
    currentTurn: 0,
    webTimeout: cfg.webTimeout,
    cfg,
    signal: opts.signal ?? null,
    // 电脑控制（Computer）会话级同意状态：bridge 构造并落盘（见 bridge.js）。
    // gate() 用它实现"首次弹窗确认、确认后本会话直接放行"，子代理经 toolCtx
    // 透传拿到同一份状态，主会话确认过一次后子代理也不再询问。
    computerConsent: opts.computerConsent ?? null,
    // HITL 提问通道（AskUserQuestion 用）：与 permissionAsk 同一范式 ——
    // 先 emit('ask-user') 让消费循环把问题推给前端，再 await 闭包挂起的
    // resolver；用户作答（或 run 结束/中止）时 resolve。缺通道时工具自带
    // 兜底文案，不会把 run 卡死。
    askUser: typeof opts.askUser === 'function' && permissionMode !== 'dont_ask'
      ? (payload) => opts.askUser({ ...payload, emit })
      : null,
    onCwdChange: (next) => {
      toolCtx.cwd = next;
      cwd = next;
      onCwdChange?.(next);
    }
  };
  const budget = cfg.maxTokensBudget ?? 24000;

  // 项目钩子的信任解析：全局信任，或这个工作目录在信任列表里。
  // （.cocode/hooks.json 来自仓库内容，不能默认执行 —— 否则 clone 即中招。）
  const hookCfg = {
    ...cfg,
    trustProjectHooks: cfg.trustProjectHooks === true
      || (Array.isArray(cfg.trustProjectHooksFor) && !!cwd && cfg.trustProjectHooksFor.includes(cwd))
  };

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };

  /** 统一事件出口。 */
  const emit = (e) => ch.push(e);

  // ---- UserPromptSubmit 钩子 ----
  // 位置在组装系统提示词之前：钩子注入的上下文会进 system（缓存友好），
  // 它也可以直接拦下这一轮（比如「这个仓库禁止自动改代码」）。
  let hookContext = '';
  try {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const hk = await runHooks('UserPromptSubmit', {
      session_id: toolCtx.sessionId,
      prompt: contentToText(lastUser?.content ?? '')
    }, { cwd: toolCtx.cwd || cwd, cfg: hookCfg });
    if (hk.ran) {
      emit({ type: 'hook', event: 'UserPromptSubmit', ran: hk.ran, decision: hk.decision || null, notices: hk.notices, errors: hk.errors });
    }
    if (hk.decision === 'deny') {
      emit({ type: 'done', reason: 'blocked', message: hk.reason, totalUsage });
      return;
    }
    hookContext = hk.additionalContext || '';
  } catch (e) {
    emit({ type: 'hook', event: 'UserPromptSubmit', ran: 0, errors: [e?.message || String(e)] });
  }

  // ---- 项目上下文（约定文件 + git 状态 + repo map + 最近改动）----
  let projectContext = null;
  if (cwd && cfg.injectProjectContext !== false) {
    try {
      projectContext = await loadProjectContext(cwd, cfg);
    } catch { /* best-effort */ }
  }

  // ---- 长期记忆（会话开场快照）----
  // 中途 MemorySave 的内容要下一轮/下次会话才注入（composeSystem 只在开场重建）。
  // 关掉项目上下文注入的用户视为同时不要记忆块。
  let memoryBlock = '';
  if (cwd && cfg.injectProjectContext !== false && loadMemoryConfig().inject_enabled) {
    try { memoryBlock = renderMemoryContext(cwd); } catch { /* 存储异常不阻断会话 */ }
  }

  let reactMode = client.supportsTools === false;
  const basePrompt = systemPrompt || cfg.systemPrompt || SYSTEM_PROMPT;
  const composeSystem = () => {
    const base = buildSystemPrompt({
      basePrompt,
      projectContext,
      reactMode,
      toolNames: allTools.map((t) => t.name),
      hookContext
    });
    // prompt.js 不动：记忆块与使用指引拼在其返回值之后（有记忆才加，不占空会话 token）
    return memoryBlock ? `${base}\n\n${memoryBlock}\n\n${MEMORY_GUIDE}` : base;
  };

  // 确保首条是 system（已存在则刷新内容，保证项目指令是最新的）
  if (!messages.length || messages[0].role !== 'system') {
    messages.unshift({ role: 'system', content: composeSystem() });
  } else {
    messages[0].content = composeSystem();
  }
  if (reactMode) emit({ type: 'mode-changed', mode: 'react', reason: '模型不支持 tool_calls，已降级为文本 ReAct' });

  const summarize = async (prompt) => {
    const { message } = await chatCompletion(client, {
      messages: [{ role: 'user', content: prompt }],
      signal
    });
    return message.content;
  };

  /** 权限闸口：返回 {behavior, decision}，ask 会挂起等用户 */
  async function gate(tc, args) {
    const name = tc.function?.name;
    const canonical = canonicalToolName(name);

    // ---- PreToolUse 钩子：在权限决策之前 ----
    // 为什么必须在权限之前：钩子是用户**显式写下**的规则（「别碰 migrations/」），
    // 它的 deny 要优先于权限模式的放行 —— 连 bypass 也不能绕过用户自己设的闸。
    // 钩子同时可以改写参数（先把命令里的危险片段去掉）或强制要求人工确认。
    let effectiveArgs = args;
    let hookContext = '';
    let hookAsk = false;
    let hookDenied = '';
    {
      const hk = await runHooks('PreToolUse', {
        session_id: toolCtx.sessionId,
        tool_name: canonical,
        tool_input: args
      }, { cwd: toolCtx.cwd || cwd, cfg: hookCfg });
      if (hk.ran || hk.errors.length) {
        emit({ type: 'hook', event: 'PreToolUse', tool: canonical, ran: hk.ran, decision: hk.decision || null, reason: hk.reason || '', notices: hk.notices, errors: hk.errors });
      }
      if (hk.updatedInput) effectiveArgs = { ...args, ...hk.updatedInput };
      hookContext = hk.additionalContext || '';
      if (hk.decision === 'deny') hookDenied = hk.reason || 'PreToolUse 钩子拒绝了本次操作';
      else if (hk.decision === 'ask') hookAsk = true;
    }

    // Computer（电脑控制）会话级同意：首次使用强制弹一次确认卡 —— 无论权限
    // 模式，连 bypass 也要问这一次（"一开始弹窗提示将使用电脑控制插件"）；
    // 用户确认后 granted=true，本会话内直接放行且不受权限模式约束
    // （explore/dont_ask 也允许）。用户显式 deny 规则与钩子仍然优先 ——
    // 它们是用户亲手写下的闸，不该被同意状态绕过。
    let decision = decidePermission(permissionMode, name, effectiveArgs, rules);
    if (canonical === 'Computer' && !hookDenied && !hookAsk) {
      if (opts.computerConsent?.granted) {
        decision = { ...decision, behavior: 'allow' };
      } else {
        decision = {
          ...decision,
          behavior: typeof permissionAsk === 'function' ? 'ask' : 'deny',
          reason: '首次使用电脑控制，需要用户确认',
          // 不提供"以后都允许"规则建议：同意本就是会话级的，每个新会话
          // 首次使用都会再确认一次。
          suggestedRules: []
        };
      }
    }
    const pack = (behavior, extra = {}) => ({ behavior, decision, args: effectiveArgs, hookContext, ...extra });
    if (hookDenied) return pack('deny', { hookDenied });
    // 钩子要求确认时，即使权限模式本该放行也走询问（用户可以在卡片上看清再决定）
    if (decision.behavior === 'allow' && !hookAsk) return pack('allow');
    if (decision.behavior === 'deny') return pack('deny');
    // ask
    if (typeof permissionAsk !== 'function') {
      return pack('deny', { noChannel: true, decision: { ...decision } });
    }
    emit({
      type: 'require-confirm',
      id: tc.id,
      name: canonical,
      args: effectiveArgs,
      suggestedRules: decision.suggestedRules,
      reason: hookAsk ? 'PreToolUse 钩子要求人工确认这次调用' : decision.reason
    });
    let answer = null;
    try {
      answer = await permissionAsk({
        id: tc.id,
        name: canonical,
        args: effectiveArgs,
        suggestedRules: decision.suggestedRules,
        category: decision.category,
        mode: permissionMode
      });
    } catch (e) {
      answer = { confirmed: false, error: e?.message || String(e) };
    }
    emit({ type: 'confirm-resolved', id: tc.id, confirmed: !!answer?.confirmed });
    // Computer 首次确认成功：记住本会话同意（onGranted 负责落盘），
    // 后续 Computer 调用直接放行、不再询问。
    if (answer?.confirmed && canonical === 'Computer' && opts.computerConsent && !opts.computerConsent.granted) {
      opts.computerConsent.granted = true;
      try { opts.computerConsent.onGranted?.(); } catch { /* ignore */ }
    }
    if (Array.isArray(answer?.rules) && answer.rules.length) {
      for (const r of answer.rules) {
        if (!r || typeof r !== 'object') continue;
        const rule = {
          tool_name: canonicalToolName(r.tool_name || name),
          rule_content: r.rule_content ?? null,
          behavior: r.behavior || 'allow',
          source: r.source || 'userSettings'
        };
        // 去重后持久化
        const dup = rules.some((x) => x.tool_name === rule.tool_name && x.rule_content === rule.rule_content && x.behavior === rule.behavior);
        if (!dup) {
          rules.push(rule);
          try { onRuleAdded?.(rule); } catch { /* ignore */ }
          // 让上层（CLI / 前端）能提示"已记住这条规则"
          emit({ type: 'rule-added', rule });
        }
      }
    }
    return pack(answer?.confirmed ? 'allow' : 'deny', { userDenied: !answer?.confirmed });
  }

  /** 真正执行一个工具调用（权限已放行） */
  async function invoke(tc, args) {
    const t0 = Date.now();
    let ok = true;
    let result;
    try {
      const tool = toolMap.get(tc.function?.name) || toolMap.get(canonicalToolName(tc.function?.name).toLowerCase());
      if (!tool) {
        result = `未知工具: ${tc.function?.name}`;
        ok = false;
      } else if (!toolCtx.cwd && canonicalToolName(tc.function?.name) !== 'WebFetch' && canonicalToolName(tc.function?.name) !== 'WebSearch') {
        result = '工具不可用：未选择工作目录。请先在会话顶部点击「选择文件夹」。';
        ok = false;
      } else if (toolCtx.signal?.aborted) {
        result = '已中止：用户停止了本次回复。';
        ok = false;
      } else {
        result = await tool.execute(args, toolCtx);
        const name = canonicalToolName(tc.function?.name);
        // Write/Edit 成功时返回带 diff 的对象；字符串是可读错误提示。
        if (['Write', 'Edit'].includes(name) && typeof result === 'string') ok = false;
        if (name === 'Bash' && typeof result === 'string') {
          const exitCode = /\bexit_code:\s*(-?\d+|null)\b/.exec(result)?.[1];
          if (exitCode !== '0' || /^(?:命令已被用户中止|命令超时|命令输出超过)/.test(result)) ok = false;
        }
        if (result && typeof result === 'object' && result.ok === false) ok = false;
      }
    } catch (e) {
      ok = false;
      result = `工具执行异常: ${e?.message || e}`;
    }
    // 工具可返回 {text, image, meta}：文本进对话与卡片，图像按多模态 part 附上，
    // meta 是结构化元数据（如 Write/Edit 的 {diff,added,removed}），随 tool-result
    // 事件透传给前端渲染 —— 不进模型上下文。
    let image = null;
    let meta = null;
    if (result && typeof result === 'object') {
      image = result.image || null;
      meta = result.meta && typeof result.meta === 'object' ? result.meta : null;
      result = result.text ?? JSON.stringify(result);
    }
    return { ok, result: String(result ?? ''), image, meta, durationMs: Date.now() - t0 };
  }

  /**
   * 工具执行 + PostToolUse 钩子。
   * 钩子能补充上下文（例如「这个文件被 .gitignore 排除了，别看它」），
   * 也能直接把这次结果判为不可接受（decision=deny/ask），此时结果会附带钩子的话
   * 一起回给模型 —— 让模型知道「不是工具坏了，是规则不让这么干」。
   */
  async function invokeWithHooks(tc, args) {
    const name = canonicalToolName(tc.function?.name);
    const res = await invoke(tc, args);
    let hk;
    try {
      hk = await runHooks('PostToolUse', {
        session_id: toolCtx.sessionId,
        tool_name: name,
        tool_input: args,
        tool_response: { ok: res.ok, result: String(res.result ?? '').slice(0, 4000) }
      }, { cwd: toolCtx.cwd || cwd, cfg: hookCfg });
    } catch (e) {
      emit({ type: 'hook', event: 'PostToolUse', tool: name, ran: 0, errors: [e?.message || String(e)] });
      return res;
    }
    if (hk.ran || hk.errors.length) {
      emit({ type: 'hook', event: 'PostToolUse', tool: name, ran: hk.ran, decision: hk.decision || null, reason: hk.reason || '', notices: hk.notices, errors: hk.errors });
    }
    if (hk.decision === 'deny' || hk.decision === 'ask') {
      res.ok = false;
      res.result = `PostToolUse 钩子不接受这次执行结果：${hk.reason || '（未说明原因）'}\n\n原始结果：\n${res.result}`;
    }
    if (hk.additionalContext) res.result = `${res.result}\n\n[钩子补充] ${hk.additionalContext}`;
    return res;
  }

  /** 统一收尾：Stop 钩子 → done 事件 */
  async function finish(reason, { runStopHook = true } = {}) {
    if (runStopHook) {
      try {
        const hk = await runHooks('Stop', {
          session_id: toolCtx.sessionId,
          reason,
          usage: totalUsage
        }, { cwd: toolCtx.cwd || cwd, cfg: hookCfg });
        if (hk.ran) {
          emit({ type: 'hook', event: 'Stop', ran: hk.ran, decision: hk.decision || null, context: hk.additionalContext || '', notices: hk.notices, errors: hk.errors });
        }
      } catch (e) {
        emit({ type: 'hook', event: 'Stop', ran: 0, errors: [e?.message || String(e)] });
      }
    }
    emit({ type: 'done', reason, totalUsage });
  }

  // ---- 结构化输出辅助函数 ----
  function buildStructuredMessages(messages, schema) {
    let lastAssistant = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.content && !m.tool_calls?.length) {
        lastAssistant = contentToText(m.content);
        break;
      }
    }
    const sys = `你必须严格按照以下 JSON Schema 输出。只能返回一个合法的 JSON 对象，不要加额外解释文字、Markdown 代码块或前后缀。`;
    return [
      { role: 'system', content: sys },
      { role: 'user', content:
          `目标 JSON Schema：\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n\n` +
          `以下是你刚才任务的产出（供参考）：\n${lastAssistant.slice(0, 4000)}` }
    ];
  }

  function extractFirstJson(text) {
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
    let m = fenceRe.exec(text);
    if (m) return m[1];
    let idx = text.indexOf('{');
    while (idx >= 0) {
      const bal = __sliceBalancedJson(text, idx);
      if (bal) return bal;
      idx = text.indexOf('{', idx + 1);
    }
    return null;
  }

  // ---- 反思返工闭环（插在 finish 前）----
  async function maybeRunReviewThenFinish() {
    // ---- 结构化输出（JSON Schema 约束）----
    async function finishWithStructuredOutput() {
      const schema = cfg.output_schema;
      const maxRounds = cfg.output_schema_max_rounds ?? 2;
      if (!schema || typeof schema !== 'object') return await finish('completed');

      let round = 0;
      while (round <= maxRounds) {
        round++;
        emit({ type: 'structured-start', round });

        let message, usage;
        try {
          const structMsgs = buildStructuredMessages(messages, schema);
          ({ message, usage } = await chatCompletion(client, {
            messages: structMsgs,
            tools: undefined,
            signal
          }));
          if (usage) {
            totalUsage.prompt_tokens += usage.prompt_tokens || 0;
            totalUsage.completion_tokens += usage.completion_tokens || 0;
          }
        } catch (e) {
          emit({ type: 'structured-failed', errors: [`chatCompletion 失败: ${e?.message || e}`] });
          break;
        }

        const text = message?.content || '';
        let jsonStr = extractFirstJson(text);
        let parsed = null;
        if (jsonStr) {
          try { parsed = JSON.parse(jsonStr); } catch { /* 不是合法 JSON */ }
        }
        if (parsed === null) {
          emit({ type: 'structured-result', round, passed: false, errors: ['不是合法 JSON'] });
          if (round <= maxRounds) continue;
          break;
        }

        const v = validateAgainstSchema(parsed, schema);
        if (v.ok) {
          emit({ type: 'structured-result', round, passed: true });
          emit({ type: 'structured-output', value: parsed });
          messages.push({ role: 'assistant', content: JSON.stringify(parsed, null, 2) });
          return await finish('completed');
        }
        emit({ type: 'structured-result', round, passed: false, errors: v.errors });
        if (round > maxRounds) break;
        messages.push({
          role: 'user',
          content:
            `你上次返回的 JSON 不符合 Schema。问题：\n${v.errors.map(e => '- ' + e).join('\n')}\n\n请按 Schema 修正后只返回纯 JSON。`
        });
      }
      emit({ type: 'structured-failed', errors: ['重试到 max_rounds 仍不通过'] });
      return await finish('completed');
    }

    const reviewCfg = cfg.review || {};
    if (!reviewCfg.enabled) return await finishWithStructuredOutput();

    const totalCalls = countToolCalls(messages);
    const minTurns = reviewCfg.min_turns ?? 3;
    if (totalCalls < minTurns) {
      emit({ type: 'review-start', round: 0, skipped: true, reason: `工具调用 ${totalCalls} < ${minTurns}` });
      return await finishWithStructuredOutput();
    }
    if (reviewCfg.only_after_mutation && !hasMutatingToolCall(messages)) {
      emit({ type: 'review-start', round: 0, skipped: true, reason: '未发生写入或执行动作' });
      return await finishWithStructuredOutput();
    }

    const maxRounds = reviewCfg.max_rounds ?? 2;
    const checklist = Array.isArray(reviewCfg.checklist) ? reviewCfg.checklist : [];
    let round = 0;

    while (round <= maxRounds) {
      round++;
      emit({ type: 'review-start', round });

      let critique, usage;
      try {
        const criticMsgs = buildCriticMessages(messages, checklist);
        ({ message: critique, usage } = await chatCompletion(client, {
          messages: criticMsgs,
          tools: undefined,
          signal
        }));
        if (usage) {
          totalUsage.prompt_tokens += usage.prompt_tokens || 0;
          totalUsage.completion_tokens += usage.completion_tokens || 0;
        }
      } catch (e) {
        emit({ type: 'review-result', round, passed: false, issues: [`Critic 调用失败: ${e?.message || e}`], reason: 'critic-error' });
        break;
      }

      const result = parseCriticResult(critique?.content || '');
      emit({ type: 'review-result', round, passed: result.passed, issues: result.issues, reason: result.reason });

      if (result.passed) return await finishWithStructuredOutput();

      if (round <= maxRounds) {
        emit({ type: 'review-redo', round, issues: result.issues });
        messages.push({
          role: 'user',
          content:
            `【自我审查反馈（第 ${round} 轮，未通过）】\n` +
            `以下问题你需要解决：\n` +
            result.issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n') +
            (result.reason ? `\n\n总体判断：${result.reason}` : '') +
            `\n\n请直接修复这些问题（可以继续调工具、跑命令、改文件），` +
            `修复后重新给出完整答复。不要只回复"我已修复"——请展示修复结果。`
        });
        const subMaxTurns = (cfg.maxTurns ?? 40) - toolCtx.currentTurn + 5;
        let exited = false;
        let subTurn = 0;
        while (!exited && subTurn < subMaxTurns) {
          subTurn++;
          toolCtx.currentTurn++;

          let message2, usage2;
          try {
            ({ message: message2, usage: usage2 } = await chatCompletion(client, {
              messages,
              tools: reactMode ? undefined : toolDefs,
              signal
            }));
          } catch (e) {
            if (e.code === 'ABORTED' || signal?.aborted) return await finish('aborted', { runStopHook: false });
            throw e;
          }
          if (usage2) {
            totalUsage.prompt_tokens += usage2.prompt_tokens || 0;
            totalUsage.completion_tokens += usage2.completion_tokens || 0;
          }

          if (reactMode) {
            const action = parseReactAction(message2.content || '');
            if (!action || action.final != null) {
              if (action?.final) { /* 流里已输出 */ }
              messages.push(message2);
              exited = true; break;
            }
            messages.push(message2);
            const name = action.tool;
            const tc = { id: `review-${round}-${toolCtx.currentTurn}-${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(action.args ?? {}) } };
            emit({ type: 'tool-start', id: tc.id, name: canonicalToolName(name), args: action.args ?? {} });
            const g = await gate(tc, action.args ?? {});
            let res;
            if (g.behavior !== 'allow') {
              res = { ok: false, result: hookOrPolicyMessage(g, name, permissionMode), image: null, durationMs: 0 };
            } else {
              res = await invokeWithHooks(tc, g.args ?? action.args ?? {});
            }
            recordToolMessage(tc, name, res);
            emit({ type: 'tool-result', id: tc.id, name: canonicalToolName(name), ok: res.ok, result: res.result, durationMs: res.durationMs, meta: res.meta ?? undefined });
            continue;
          }

          messages.push(message2);
          if (!message2.tool_calls?.length) {
            exited = true; break;
          }
          const calls2 = [];
          for (const tc of message2.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
            calls2.push({ tc, args, category: toolCategory(tc.function?.name, args) });
          }
          await maybeCheckpoint(toolCtx.currentTurn, calls2);
          for (const c of calls2) {
            emit({ type: 'tool-start', id: c.tc.id, name: canonicalToolName(c.tc.function?.name), args: c.args });
          }
          for (const c of calls2) {
            if (signal?.aborted) return await finish('aborted', { runStopHook: false });
            const g = await gate(c.tc, c.args);
            let res;
            if (g.behavior === 'allow') res = await invokeWithHooks(c.tc, g.args ?? c.args);
            else res = { ok: false, result: hookOrPolicyMessage(g, c.tc.function?.name, permissionMode), image: null, durationMs: 0 };
            recordToolMessage(c.tc, c.tc.function?.name, res);
            emit({ type: 'tool-result', id: c.tc.id, name: canonicalToolName(c.tc.function?.name), ok: res.ok, result: res.result, durationMs: res.durationMs, meta: res.meta ?? undefined });
          }
        }
        if (!exited) {
          return await finish('max-turns');
        }
      } else {
        emit({ type: 'review-result', round, passed: false, issues: result.issues, reason: 'max-rounds' });
        return await finishWithStructuredOutput();
      }
    }
    return await finishWithStructuredOutput();
  }

  function recordToolMessage(tc, name, res) {
    const content = res.image
      ? [
          { type: 'text', text: res.result },
          { type: 'image_url', image_url: { url: res.image.data_url } }
        ]
      : res.result;
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content,
      tool_name: canonicalToolName(name),
      tool_state: res.ok ? 'success' : 'error',
      tool_metadata: { duration_ms: res.durationMs, ...(res.image ? { image: true } : {}) }
    });
  }

  /** 本轮是否需要对工作目录做检查点 */
  async function maybeCheckpoint(turn, calls) {
    // 全盘默认模式下整棵家目录做快照 = 每轮遍历数万文件，成本失控——跳过。
    if (!checkpoint?.enabled || !checkpoint?.sessionId || !toolCtx.cwd || defaultFullDisk) return;
    const needs = calls.some((c) => ['write', 'execute'].includes(toolCategory(c.tc.function?.name, c.args)));
    if (!needs) return;
    try {
      const r = checkpointSnapshot(toolCtx.cwd, { sessionId: checkpoint.sessionId, turn });
      if (r.ok) emit({ type: 'checkpoint', turn, fileCount: r.fileCount, bytes: r.bytes });
    } catch { /* 快照失败不该挡住执行 */ }
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return await finish('aborted', { runStopHook: false });
    toolCtx.currentTurn = turn;

    // ---- 低 token 治理：先驱逐，再压缩 ----
    let evicted = 0, compacted = false;
    const tokensBefore = estimateMessagesTokens(messages);
    const step1 = evictToolOutputs(messages, budget);
    if (step1.evicted > 0) {
      messages.splice(0, messages.length, ...step1.messages);
      evicted = step1.evicted;
    }
    if (estimateMessagesTokens(messages) > budget) {
      const before = estimateMessagesTokens(messages);
      const step2 = await compactMessages(messages, { budget, summarize });
      if (step2.compacted && estimateMessagesTokens(step2.messages) < before) {
        messages.splice(0, messages.length, ...step2.messages);
        compacted = true;
      }
    }
    if (evicted || compacted) {
      emit({
        type: 'compact',
        evicted,
        compacted,
        tokensBefore,
        tokensAfter: estimateMessagesTokens(messages),
        budget
      });
    }

    // ---- 模型调用（含能力降级重试）----
    let message, usage;
    try {
      ({ message, usage } = await chatCompletion(client, {
        messages,
        tools: reactMode ? undefined : toolDefs,
        signal,
        onDelta: (text) => emit({ type: 'text-delta', text }),
        onThinking: (text) => emit({ type: 'thinking-delta', text })
      }));
    } catch (e) {
      if (e.code === 'ABORTED' || signal?.aborted) {
        return await finish('aborted', { runStopHook: false });
      }
      if (e.code === 'TOOL_UNSUPPORTED' && !reactMode) {
        // 端点不支持 function calling → 记下能力，改走文本 ReAct 重试本轮
        markToolUnsupported(cfg);
        reactMode = true;
        messages[0].content = composeSystem();
        emit({ type: 'mode-changed', mode: 'react', reason: e.message });
        turn--; // 本轮不算数，重跑
        continue;
      }
      throw e;
    }
    if (usage) {
      totalUsage.prompt_tokens += usage.prompt_tokens || 0;
      totalUsage.completion_tokens += usage.completion_tokens || 0;
      totalUsage.cached_tokens += usage.cached_tokens || 0;
    }
    emit({ type: 'turn-end', turn, usage });

    // ---- ReAct 模式：从文本里解析动作 ----
    if (reactMode) {
      const action = parseReactAction(message.content || '');
      if (!action || action.final != null) {
        if (action?.final) { /* final 正文已在流里输出过 */ }
        messages.push(message);
        return await maybeRunReviewThenFinish();
      }
      messages.push(message);
      const name = action.tool;
      const tc = { id: `react-${turn}-${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(action.args ?? {}) } };
      emit({ type: 'tool-start', id: tc.id, name: canonicalToolName(name), args: action.args ?? {} });
      const g = await gate(tc, action.args ?? {});
      let res;
      if (g.behavior !== 'allow') {
        res = {
          ok: false,
          result: hookOrPolicyMessage(g, name, permissionMode),
          image: null,
          durationMs: 0
        };
      } else {
        res = await invokeWithHooks(tc, g.args ?? action.args ?? {});
      }
      messages.push({
        role: 'user',
        content: `工具 ${canonicalToolName(name)} 的执行结果（${res.ok ? '成功' : '失败'}）：\n${res.result}`
      });
      emit({ type: 'tool-result', id: tc.id, name: canonicalToolName(name), ok: res.ok, result: res.result, durationMs: res.durationMs, meta: res.meta ?? undefined });
      continue;
    }

    // ---- 工具调用 ----
    messages.push(message);
    if (!message.tool_calls?.length) {
      return await maybeRunReviewThenFinish();
    }

    // 1) 先解析参数并算出每个调用的类别/权限（纯计算，方便并发）
    const calls = [];
    for (const tc of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); }
      catch { /* 模型偶发非严格 JSON，按空参处理 */ }
      calls.push({ tc, args, category: toolCategory(tc.function?.name, args) });
    }

    // 2) 检查点：本轮有写/执行动作时，先给工作目录拍快照
    await maybeCheckpoint(turn, calls);

    // 3) 全部 tool-start 先发出去（前端卡片按顺序出现）
    for (const c of calls) {
      emit({ type: 'tool-start', id: c.tc.id, name: canonicalToolName(c.tc.function?.name), args: c.args });
    }

    // 4) 并发判定：全是只读且无需询问时可以并发跑（多个独立读操作）
    const canParallel = calls.length > 1 && calls.every((c) => {
      if (c.category !== 'read') return false;
      return decidePermission(permissionMode, c.tc.function?.name, c.args, rules).behavior === 'allow';
    });

    if (canParallel) {
      const results = await Promise.all(calls.map(async (c) => {
        if (signal?.aborted) return { c, res: { ok: false, result: '已中止', image: null, durationMs: 0 } };
        const g = await gate(c.tc, c.args);
        if (g.behavior !== 'allow') {
          return { c, res: { ok: false, result: hookOrPolicyMessage(g, c.tc.function?.name, permissionMode), image: null, durationMs: 0 } };
        }
        return { c, res: await invokeWithHooks(c.tc, g.args ?? c.args) };
      }));
      for (const { c, res } of results) {
        recordToolMessage(c.tc, c.tc.function?.name, res);
        emit({ type: 'tool-result', id: c.tc.id, name: canonicalToolName(c.tc.function?.name), ok: res.ok, result: res.result, durationMs: res.durationMs, meta: res.meta ?? undefined });
      }
      continue;
    }

    for (const c of calls) {
      if (signal?.aborted) return await finish('aborted', { runStopHook: false });
      const g = await gate(c.tc, c.args);
      let res;
      if (g.behavior === 'allow') {
        res = await invokeWithHooks(c.tc, g.args ?? c.args);
      } else {
        res = { ok: false, result: hookOrPolicyMessage(g, c.tc.function?.name, permissionMode), image: null, durationMs: 0 };
      }
      recordToolMessage(c.tc, c.tc.function?.name, res);
      emit({ type: 'tool-result', id: c.tc.id, name: canonicalToolName(c.tc.function?.name), ok: res.ok, result: res.result, durationMs: res.durationMs, meta: res.meta ?? undefined });
    }
  }
  await finish('max-turns');
}
