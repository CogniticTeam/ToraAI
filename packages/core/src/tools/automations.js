// 事件触发自动化：比 hooks 更上层的「当 X 发生时做 Y」规则系统
//
// 与 hooks 的分工：
//   hooks  = 低层、面向权限决策（allow/deny/ask），命令从 stdin 读 JSON、stdout 出决策
//   automations = 高层、面向副作用（通知、建检查点、跑命令），不需要写脚本解析 JSON
//
// 规则存储：~/.vega/automations.json（用户级，总是生效）
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
import { VEGA_DIR } from '../config.js';
import { matcherMatches } from '../hooks.js';

const AUTOMATIONS_PATH = join(VEGA_DIR, 'automations.json');
const DEFAULT_TIMEOUT = 10;

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

/** 新增规则。返回新规则。 */
export function createAutomation(rule) {
  const list = listAutomations();
  const r = {
    id: genId(),
    name: String(rule.name || '未命名规则'),
    enabled: rule.enabled !== false,
    event: String(rule.event || ''),
    matcher: rule.matcher ? String(rule.matcher) : '*',
    actions: Array.isArray(rule.actions) ? rule.actions : [],
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
  list[idx] = { ...list[idx], ...patch, id };
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

/** 跑一条命令，返回 {ok, stdout, stderr, error}。 */
function runCommand(command, cwd, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(command, [], { cwd, shell: true, env: { ...process.env, PATH: process.env.PATH } });
    } catch (e) {
      return resolve({ ok: false, error: e?.message || String(e) });
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, timeout * 1000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    proc.on('close', () => { clearTimeout(timer); resolve({ ok: true, stdout: out, stderr: err }); });
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
  if (cfg.automationsEnabled === false) return;
  const rules = listAutomations().filter((r) => r.enabled && r.event === event);
  if (!rules.length) return;

  for (const rule of rules) {
    if ((event === 'PreToolUse' || event === 'PostToolUse') && !matcherMatches(rule.matcher, payload?.tool_name)) continue;
    for (const action of rule.actions) {
      try {
        if (action.type === 'command' && action.command) {
          await runCommand(action.command, cwd, Number(action.timeout) || DEFAULT_TIMEOUT);
        } else if (action.type === 'checkpoint') {
          if (cwd && sessionId) {
            const { snapshot } = await import('./checkpoint.js');
            snapshot(cwd, { sessionId, turn: currentTurn ?? 0, label: `auto:${rule.name}` });
          }
        } else if (action.type === 'notify' && action.message) {
          pushNotification(sessionId, action.message);
        }
      } catch {
        // 自动化失败不影响主流程
      }
    }
  }
}
