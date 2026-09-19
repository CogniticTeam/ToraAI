// 内置终端：每个会话一个持久交互 shell（$SHELL -i），SSE 下行 + POST 上行。
// 有意不用 node-pty：原生模块需要编译链且破坏 core 零依赖策略。
// 非 TTY 下 shell 自动走逐行模式（无 curses 全屏），TERM=dumb 让输出干净可渲染，
// 覆盖"看输出、敲命令、跑构建"的日常场景；job control / 全屏 TUI 不在此承诺内。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_TERMINALS = 8; // 并发上限：超出回收最旧的空闲终端
const HISTORY_LIMIT = 200_000; // 每终端输出回放上限（字符）：面板重开能看到之前的输出
const IDLE_MS = 30 * 60 * 1000; // 无订阅者空闲多久后回收
const EXIT_TTL = 60_000; // 已退出终端保留多久，让订阅者能收到 exit 事件

const terminals = new Map(); // id -> terminal 记录

function pushHistory(t, chunk) {
  t.history.push(chunk);
  let size = 0;
  for (const c of t.history) size += c.length;
  while (size > HISTORY_LIMIT && t.history.length > 1) {
    size -= t.history[0].length;
    t.history.shift();
  }
}

function broadcast(t, event) {
  for (const fn of t.subs) {
    try { fn(event); } catch { t.subs.delete(fn); }
  }
}

export function createTerminal({ cwd, shell } = {}) {
  sweep();
  const sh = String(shell || process.env.SHELL || '/bin/sh');
  const dir = cwd || process.cwd();
  const proc = spawn(sh, ['-i'], {
    cwd: dir,
    env: { ...process.env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const t = {
    id: randomUUID(), proc, shell: sh, cwd: dir,
    subs: new Set(), history: [],
    created_at: Date.now(), last_active: Date.now(),
    exited: false, code: null, exit_at: 0,
  };
  proc.stdout?.on('data', (d) => {
    t.last_active = Date.now();
    const text = d.toString('utf8');
    pushHistory(t, text);
    broadcast(t, { type: 'data', stream: 'out', data: text });
  });
  proc.stderr?.on('data', (d) => {
    t.last_active = Date.now();
    const text = d.toString('utf8');
    pushHistory(t, text);
    broadcast(t, { type: 'data', stream: 'err', data: text });
  });
  proc.on('error', (e) => {
    t.exited = true; t.exit_at = Date.now(); t.code = -1;
    broadcast(t, { type: 'exit', code: -1, error: e?.message || String(e) });
  });
  proc.on('close', (code, signal) => {
    t.exited = true; t.exit_at = Date.now(); t.code = code;
    broadcast(t, { type: 'exit', code, signal });
    t.subs.clear();
  });
  terminals.set(t.id, t);
  if (terminals.size > MAX_TERMINALS) {
    const idle = [...terminals.values()]
      .filter((x) => !x.exited && x.subs.size === 0)
      .sort((a, b) => a.last_active - b.last_active)[0];
    if (idle) killTerminal(idle.id, '超出并发上限，回收最旧空闲终端');
  }
  return { id: t.id, shell: sh, cwd: dir, pid: proc.pid };
}

export function writeTerminal(id, data) {
  const t = terminals.get(id);
  if (!t || t.exited) return false;
  if (typeof data !== 'string') return false;
  t.last_active = Date.now();
  t.proc.stdin.write(data);
  return true;
}

export function killTerminal(id, reason) {
  const t = terminals.get(id);
  if (!t || t.exited) return false;
  t.kill_reason = reason || null;
  try { t.proc.kill('SIGTERM'); } catch { /* already gone */ }
  const hard = setTimeout(() => { try { if (!t.exited) t.proc.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
  hard.unref?.();
  return true;
}

export function getTerminal(id) {
  const t = terminals.get(id);
  if (!t) return null;
  return { id: t.id, shell: t.shell, cwd: t.cwd, exited: t.exited, code: t.code, subs: t.subs.size };
}

export function subscribeTerminal(id, fn) {
  const t = terminals.get(id);
  if (!t) return null;
  t.subs.add(fn);
  t.last_active = Date.now();
  return () => t.subs.delete(fn);
}

export function replayTerminal(id) {
  const t = terminals.get(id);
  if (!t) return null;
  return { history: t.history.join(''), exited: t.exited, code: t.code };
}

function sweep() {
  const now = Date.now();
  for (const [id, t] of terminals) {
    if (t.exited) {
      if (t.exit_at && now - t.exit_at > EXIT_TTL) terminals.delete(id);
    } else if (t.subs.size === 0 && now - t.last_active > IDLE_MS) {
      try { t.proc.kill('SIGKILL'); } catch { /* gone */ }
      t.exited = true; t.exit_at = now;
      terminals.delete(id);
    }
  }
}

// 惰性清扫：unref 保证不阻塞进程退出（测试进程可自然结束）
setInterval(sweep, 60_000).unref();
