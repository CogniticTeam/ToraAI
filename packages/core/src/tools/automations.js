// 事件触发自动化：比 hooks 更上层的「当 X 发生时做 Y」规则系统
//
// 与 hooks 的分工：
//   hooks  = 低层、面向权限决策（allow/deny/ask），命令从 stdin 读 JSON、stdout 出决策
//   automations = 高层、面向副作用（通知、建检查点、跑命令），不需要写脚本解析 JSON
//
// 规则存储：~/.cocode/automations.json（用户级，总是生效）
//   [{ id, name, enabled, event, matcher, actions: [{type, ...params}] }]
//
// 支持的事件：UserPromptSubmit / PreToolUse / PostToolUse / Stop
// 支持的动作：
//   - command:  { command: string, timeout?: number }  跑一条 shell 命令（不经 stdin）
//   - checkpoint: {}                                   给当前工作目录建一个检查点
//   - notify:   { message: string }                    推一条通知到前端（会话内可见）
//
// 执行时机：runHooks 末尾顺带跑 runAutomations（事件相同时复用 matcher 过滤）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { COCODE_DIR } from '../config.js';
import { matcherMatches } from '../hooks.js';
import { buildChildEnv } from '../security.js';

const AUTOMATIONS_PATH = join(COCODE_DIR, 'automations.json');
const DEFAULT_TIMEOUT = 10;
const MAX_TIMEOUT = 60;
const AUTOMATION_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
const ACTION_TYPES = new Set(['command', 'checkpoint', 'notify']);

// 会话级通知队列：notify 动作往里 push，前端 GET /sessions/:id/notifications 拉取
const notifications = new Map(); // sessionId → [{id, message, at}]

function ensureDir() {
  mkdirSync(dirname(AUTOMATIONS_PATH), { recursive: true });
}

/** 读取全部规则。 */
export function listAutomations() {
  if (!existsSync(AUTOMATIONS_PATH)) return [];
  try { return JSON.parse(readFileSync(AUTOMATIONS_PATH, 'utf8')) || []; }
  catch { return []; }
}

function saveAutomations(list) {
  ensureDir();
  writeFileSync(AUTOMATIONS_PATH, JSON.stringify(list, null, 2));
}

function genId() {
  return 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 自动化规则在写盘前统一校验与规范化。它们会在未来的 Agent 轮次中执行，
 * 不能像普通 UI 偏好一样“先存再说”。返回 value 以便 HTTP 层给用户明确报错。
 */
export function validateAutomation(rule, base = null) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return { ok: false, error: '自动化规则必须是对象' };
  const source = { ...(base || {}), ...rule };
  const name = String(source.name || '').trim();
  if (!name || name.length > 120) return { ok: false, error: '规则名称不能为空且不能超过 120 字符' };
  const event = String(source.event || '');
  if (!AUTOMATION_EVENTS.has(event)) return { ok: false, error: `event 必须是 ${[...AUTOMATION_EVENTS].join('、')} 之一` };
  const matcher = source.matcher == null ? '*' : String(source.matcher).trim();
  if (!matcher || matcher.length > 200) return { ok: false, error: 'matcher 不能为空且不能超过 200 字符' };
  if (!Array.isArray(source.actions) || source.actions.length === 0 || source.actions.length > 20) {
    return { ok: false, error: 'actions 必须是 1–20 个动作组成的数组' };
  }
  const actions = [];
  for (const raw of source.actions) {
    if (!raw || typeof raw !== 'object' || !ACTION_TYPES.has(raw.type)) {
      return { ok: false, error: '动作类型只能是 command、checkpoint 或 notify' };
    }
    if (raw.type === 'command') {
      const command = String(raw.command || '').trim();
      if (!command || command.length > 2000) return { ok: false, error: 'command 不能为空且不能超过 2000 字符' };
      const timeout = Math.max(1, Math.min(MAX_TIMEOUT, Number(raw.timeout) || DEFAULT_TIMEOUT));
      actions.push({ type: 'command', command, timeout });
    } else if (raw.type === 'notify') {
      const message = String(raw.message || '').trim();
      if (!message || message.length > 1000) return { ok: false, error: '通知内容不能为空且不能超过 1000 字符' };
      actions.push({ type: 'notify', message });
    } else {
      actions.push({ type: 'checkpoint' });
    }
  }
  return { ok: true, value: { name, event, matcher, actions, enabled: source.enabled !== false } };
}

/** 新增规则。返回新规则。 */
export function createAutomation(rule) {
  const checked = validateAutomation(rule);
  if (!checked.ok) return checked;
  const list = listAutomations();
  const r = {
    id: genId(),
    ...checked.value,
    created_at: new Date().toISOString(),
  };
  list.push(r);
  saveAutomations(list);
  return r;
}

/** 更新规则（局部字段）。 */
export function updateAutomation(id, patch) {
  const list = listAutomations();
  const idx = list.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const checked = validateAutomation(patch, list[idx]);
  if (!checked.ok) return checked;
  list[idx] = { ...list[idx], ...checked.value, id, created_at: list[idx].created_at };
  saveAutomations(list);
  return list[idx];
}

/** 删除规则。 */
export function deleteAutomation(id) {
  const list = listAutomations().filter((r) => r.id !== id);
  saveAutomations(list);
  return { ok: true };
}

/** 推一条通知到会话队列。 */
export function pushNotification(sessionId, message) {
  if (!sessionId) return;
  const arr = notifications.get(sessionId) || [];
  arr.push({ id: genId(), message: String(message), at: Date.now() });
  if (arr.length > 50) arr.splice(0, arr.length - 50);
  notifications.set(sessionId, arr);
}

/** 拉取会话通知（消费式：读完清空）。 */
export function drainNotifications(sessionId) {
  const arr = notifications.get(sessionId) || [];
  notifications.set(sessionId, []);
  return arr;
}

/** 跑一条命令，返回真实退出状态；自动化不应继承 API Key 等敏感环境。 */
function runCommand(command, cwd, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    let proc;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    try {
      proc = spawn('/bin/sh', ['-c', command], {
        cwd: cwd || process.cwd(),
        env: buildChildEnv(process.env, { COCODE_AUTOMATION: '1' }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      return finish({ ok: false, error: e?.message || String(e) });
    }
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, error: `自动化命令超时（${timeout}s）`, stdout: out, stderr: err });
    }, timeout * 1000);
    proc.stdout.on('data', (d) => { if (out.length < 200_000) out += d.toString(); });
    proc.stderr.on('data', (d) => { if (err.length < 20_000) err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message, stdout: out, stderr: err }); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return finish({ ok: true, code: 0, stdout: out, stderr: err });
      finish({ ok: false, code: code == null ? -1 : code, signal, stdout: out, stderr: err, error: err.trim() || `命令退出码 ${code == null ? 'unknown' : code}` });
    });
  });
}

/**
 * 执行匹配当前事件的所有自动化规则。
 * 与 runHooks 同事件同 matcher 过滤；只做副作用，不返回权限决策。
 * @param {string} event
 * @param {object} payload - 含 tool_name 等字段
 * @param {{cwd?:string, sessionId?:string, cfg?:object, currentTurn?:number}} ctx
 */
export async function runAutomations(event, payload, ctx = {}) {
  const { cwd, sessionId, cfg = {}, currentTurn } = ctx;
  if (cfg.automationsEnabled === false) return [];
  const rules = listAutomations().filter((r) => r.enabled && r.event === event);
  if (!rules.length) return [];
  const results = [];

  for (const rule of rules) {
    if ((event === 'PreToolUse' || event === 'PostToolUse') && !matcherMatches(rule.matcher, payload?.tool_name)) continue;
    for (const action of rule.actions) {
      try {
        if (action.type === 'command' && action.command) {
          const result = await runCommand(action.command, cwd, Math.max(1, Math.min(MAX_TIMEOUT, Number(action.timeout) || DEFAULT_TIMEOUT)));
          results.push({ rule_id: rule.id, action: 'command', ...result });
          if (!result.ok) pushNotification(sessionId, `自动化「${rule.name}」命令失败：${String(result.error || '未知错误').slice(0, 300)}`);
        } else if (action.type === 'checkpoint') {
          if (cwd && sessionId) {
            const { snapshot } = await import('./checkpoint.js');
            snapshot(cwd, { sessionId, turn: currentTurn ?? 0, label: `auto:${rule.name}` });
            results.push({ rule_id: rule.id, action: 'checkpoint', ok: true });
          }
        } else if (action.type === 'notify' && action.message) {
          pushNotification(sessionId, action.message);
          results.push({ rule_id: rule.id, action: 'notify', ok: true });
        }
      } catch (e) {
        const error = e?.message || String(e);
        results.push({ rule_id: rule.id, action: action.type || 'unknown', ok: false, error });
        pushNotification(sessionId, `自动化「${rule.name}」失败：${error.slice(0, 300)}`);
      }
    }
  }
  return results;
}
