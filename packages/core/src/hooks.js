// Hooks：在 Agent 生命周期的固定点执行用户自己的命令
//
// 事件：UserPromptSubmit / PreToolUse / PostToolUse / Stop
//
// 配置（两种位置，项目级追加在用户级之后）：
//   ~/.cocode/hooks.json          用户级（总是生效）
//   <cwd>/.cocode/hooks.json    项目级（**默认不执行**，见下面的安全说明）
//
// 格式（兼容 Claude Code 风格，也支持扁平写法）：
//   {
//     "hooks": {
//       "PreToolUse": [
//         { "matcher": "Bash|Write",
//           "hooks": [{ "type": "command", "command": "node .cocode/hooks/guard.js", "timeout": 5 }] }
//       ]
//     }
//   }
//   或 { "PreToolUse": [{ "matcher": "Bash", "command": "..." }] }
//
// 钩子的输入：事件 JSON 从 stdin 传入。输出：
//   - 空 → 不影响
//   - JSON {"decision":"allow|deny|ask","reason":"...","updatedInput":{...},
//           "additionalContext":"...","systemMessage":"..."}
//     也接受 Claude 风格 {"hookSpecificOutput":{"permissionDecision":"deny",...}}
//   - 非 JSON 文本 → 当作 additionalContext
//   - 退出码 2 → 视为阻断（block），stderr 作为原因
//
// ⚠️ 安全：项目级 hooks 来自仓库内容，clone 一个仓库就执行其中的命令等于
// 任意代码执行。所以只有在 cfg.trustProjectHooks === true（用户显式信任）时
// 才会执行项目级 hooks；否则只把「检测到未信任的项目级 hooks」作为事件上报。
// 用户级 hooks 在用户自己的机器上，等同用户自己的意图，总是执行。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildChildEnv } from './security.js';
import { COCODE_DIR } from './config.js';
import { runAutomations } from './tools/automations.js';

export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

export const USER_HOOKS_PATH = join(COCODE_DIR, 'hooks.json');
export const PROJECT_HOOKS_PATH = (cwd) => join(cwd, '.cocode', 'hooks.json');

const DEFAULT_TIMEOUT = 10; // 秒

function readJsonFile(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { __parseError: p }; }
}

/** 把一个文件里的 hooks 配置规范化成 {Event: [{matcher, command, timeout}]} */
function normalize(conf, source) {
  if (!conf || typeof conf !== 'object') return { events: {}, errors: [] };
  const root = conf.hooks && typeof conf.hooks === 'object' ? conf.hooks : conf;
  const events = {};
  const errors = [];
  for (const key of Object.keys(root)) {
    if (!HOOK_EVENTS.includes(key)) continue;
    const raw = root[key];
    if (!Array.isArray(raw)) { errors.push(`${source}: ${key} 必须是数组`); continue; }
    const list = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const matcher = entry.matcher ? String(entry.matcher) : '*';
      const timeout = Number(entry.timeout) > 0 ? Number(entry.timeout) : DEFAULT_TIMEOUT;
      const cmds = Array.isArray(entry.hooks)
        ? entry.hooks.map((h) => (typeof h === 'string' ? h : h?.command)).filter(Boolean)
        : (entry.command ? [String(entry.command)] : []);
      for (const command of cmds) list.push({ matcher, command, timeout, source });
    }
    if (list.length) events[key] = (events[key] || []).concat(list);
  }
  return { events, errors };
}

/**
 * 读取生效的 hooks。
 * @returns {{events:object, errors:string[], projectHooksPresent:boolean, projectHooksTrusted:boolean, paths:string[]}}
 */
export function loadHooks(cwd, cfg = {}) {
  const errors = [];
  const merged = {};
  const paths = [];

  const userConf = readJsonFile(USER_HOOKS_PATH);
  if (userConf?.__parseError) errors.push(`${userConf.__parseError} 不是合法 JSON`);
  else if (userConf) {
    paths.push(USER_HOOKS_PATH);
    const n = normalize(userConf, 'user');
    errors.push(...n.errors);
    for (const [k, v] of Object.entries(n.events)) merged[k] = (merged[k] || []).concat(v);
  }

  let projectHooksPresent = false;
  const projectHooksTrusted = cfg.trustProjectHooks === true;
  if (cwd) {
    const p = PROJECT_HOOKS_PATH(cwd);
    const projectConf = readJsonFile(p);
    if (projectConf?.__parseError) errors.push(`${projectConf.__parseError} 不是合法 JSON`);
    else if (projectConf) {
      projectHooksPresent = true;
      if (projectHooksTrusted) {
        paths.push(p);
        const n = normalize(projectConf, 'project');
        errors.push(...n.errors);
        for (const [k, v] of Object.entries(n.events)) merged[k] = (merged[k] || []).concat(v);
      }
    }
  }

  return { events: merged, errors, projectHooksPresent, projectHooksTrusted, paths };
}

/** matcher 匹配工具名：支持 `*`、`Bash|Write`、`Bash*` */
export function matcherMatches(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  const name = String(toolName || '');
  const pattern = '^(' + matcher.split('|').map((s) => s.trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')).join('|') + ')$';
  try { return new RegExp(pattern).test(name); } catch { return false; }
}

function runCommand(command, payload, { cwd, timeout }) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/sh';
    let proc;
    try {
      proc = spawn(shell, ['-c', command], {
        cwd: cwd || process.cwd(),
        env: buildChildEnv(process.env, { COCODE_HOOK: '1' }),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      return resolve({ ok: false, error: `无法启动钩子: ${e.message}` });
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, error: `钩子超时（${timeout}s）` });
    }, timeout * 1000);

    proc.stdout.on('data', (d) => { if (out.length < 200_000) out += d.toString(); });
    proc.stderr.on('data', (d) => { if (err.length < 20_000) err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    proc.on('close', (code, sig) => {
      clearTimeout(timer);
      finish({ ok: true, code: code == null ? -1 : code, signal: sig, stdout: out, stderr: err });
    });
    try { proc.stdin.end(JSON.stringify(payload)); } catch { /* ignore */ }
  });
}

/** 解析钩子的 stdout，得到它对本次动作的意见 */
function parseHookOutput(res) {
  const text = (res.stdout || '').trim();
  const verdict = {
    decision: null, reason: '', additionalContext: '', updatedInput: null,
    systemMessage: '', blocked: false, warned: ''
  };
  if (res.code === 2) {
    verdict.blocked = true;
    verdict.decision = 'deny';
    verdict.reason = (res.stderr || text || '钩子以退出码 2 阻断了本次操作').trim().slice(0, 2000);
    return verdict;
  }
  if (res.code !== 0) {
    verdict.warned = `钩子退出码 ${res.code}${res.stderr ? ': ' + res.stderr.trim().slice(0, 400) : ''}`;
  }
  if (!text) return verdict;

  let obj = null;
  try { obj = JSON.parse(text); } catch { /* 纯文本 → additionalContext */ }
  if (!obj || typeof obj !== 'object') {
    verdict.additionalContext = text.slice(0, 4000);
    return verdict;
  }
  const hso = obj.hookSpecificOutput || {};
  const d = obj.decision || hso.permissionDecision;
  if (d === 'allow' || d === 'deny' || d === 'ask' || d === 'approve' || d === 'block') {
    verdict.decision = d === 'approve' ? 'allow' : (d === 'block' ? 'deny' : d);
  }
  verdict.reason = String(obj.reason || hso.permissionDecisionReason || obj.message || '').slice(0, 2000);
  verdict.additionalContext = String(obj.additionalContext || hso.additionalContext || '').slice(0, 8000);
  verdict.systemMessage = String(obj.systemMessage || '').slice(0, 2000);
  if (obj.updatedInput && typeof obj.updatedInput === 'object') verdict.updatedInput = obj.updatedInput;
  return verdict;
}

/**
 * 对某个事件执行所有匹配的钩子（按配置顺序，串行）。
 *
 * 语义：deny 一旦出现就短路返回；ask 会被记住（最终 ask 优先于 allow 之外的默认）；
 * updatedInput 会依次覆盖（后者看到前者改过的输入）；
 * additionalContext 全部拼接。
 *
 * @returns {{decision:null|'allow'|'deny'|'ask', reason:string, additionalContext:string,
 *            updatedInput:object|null, ran:number, errors:string[], notices:string[]}}
 */
export async function runHooks(event, payload, ctx = {}) {
  const out = { decision: null, reason: '', additionalContext: '', updatedInput: null, ran: 0, errors: [], notices: [] };
  const { cwd, cfg = {} } = ctx;

  if (cfg.hooksEnabled === false) return out;

  const { events, errors, projectHooksPresent, projectHooksTrusted } = loadHooks(cwd, cfg);
  out.errors.push(...errors);
  if (projectHooksPresent && !projectHooksTrusted) {
    out.notices.push('检测到工作目录里的 .cocode/hooks.json，但未信任项目钩子，已跳过执行（可在设置里开启「信任项目钩子」）。');
  }
  const list = events[event];
  if (!list?.length) return out;

  let currentPayload = { hook_event_name: event, cwd: cwd || null, timestamp: Date.now(), ...payload };
  const contexts = [];

  for (const h of list) {
    if ((event === 'PreToolUse' || event === 'PostToolUse') && !matcherMatches(h.matcher, currentPayload.tool_name)) continue;
    out.ran++;
    const res = await runCommand(h.command, currentPayload, { cwd, timeout: h.timeout });
    if (!res.ok) { out.errors.push(`${h.command} → ${res.error}`); continue; }
    const v = parseHookOutput(res);
    if (v.warned) out.notices.push(`${h.command}: ${v.warned}`);
    if (v.additionalContext) contexts.push(v.additionalContext);
    if (v.systemMessage) out.notices.push(v.systemMessage);
    if (v.updatedInput) {
      out.updatedInput = { ...(out.updatedInput || {}), ...v.updatedInput };
      if (event === 'PreToolUse') currentPayload = { ...currentPayload, tool_input: out.updatedInput };
    }
    if (v.decision === 'deny') {
      out.decision = 'deny';
      out.reason = v.reason || `钩子 ${h.command} 拒绝了本次操作`;
      out.additionalContext = contexts.join('\n\n');
      return out; // deny 短路：后面的钩子没必要再跑
    }
    if (v.decision === 'ask' && out.decision !== 'ask') {
      out.decision = 'ask';
      out.reason = v.reason || `钩子 ${h.command} 要求人工确认`;
    }
  }
  out.additionalContext = contexts.join('\n\n');
  // 自动化规则：与 hooks 同事件触发，只做副作用（通知/检查点/命令），不影响权限决策
  await runAutomations(event, currentPayload, ctx);
  return out;
}

/** 给 CLI / 设置页展示用：当前生效了几个钩子 */
export function describeHooks(cwd, cfg = {}) {
  const { events, errors, projectHooksPresent, projectHooksTrusted, paths } = loadHooks(cwd, cfg);
  const rows = [];
  for (const e of HOOK_EVENTS) {
    for (const h of events[e] || []) rows.push({ event: e, matcher: h.matcher, command: h.command, timeout: h.timeout, source: h.source });
  }
  return { rows, errors, projectHooksPresent, projectHooksTrusted, paths };
}
