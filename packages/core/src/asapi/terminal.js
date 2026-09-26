// 内置终端：每个会话一个持久交互 shell（$SHELL -i），SSE 下行 + POST 上行。
// 有意不用 node-pty：原生模块需要编译链且破坏 core 零依赖策略。
// 非 TTY 下 shell 自动走逐行模式（无 curses 全屏），TERM=dumb 让输出干净可渲染，
// 覆盖"看输出、敲命令、跑构建"的日常场景；job control / 全屏 TUI 不在此承诺内。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const MAX_TERMINALS = 8; // 并发上限：超出回收最旧的空闲终端
const HISTORY_LIMIT = 200_000; // 每终端输出回放上限（字符）：面板重开能看到之前的输出
const IDLE_MS = 30 * 60 * 1000; // 无订阅者空闲多久后回收
const EXIT_TTL = 60_000; // 已退出终端保留多久，让订阅者能收到 exit 事件

const terminals = new Map(); // id -> terminal 记录

function signalTerminal(t, signal) {
  if (process.platform === 'win32' && t.proc.pid) {
    // taskkill /T 递归停止 cmd.exe 的子命令；单独 proc.kill 可能留下后台进程。
    try {
      const killer = spawn('taskkill', ['/PID', String(t.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { t.proc.kill(signal); } catch { /* gone */ } });
      killer.unref();
      return true;
    } catch { /* 回退到进程句柄 */ }
  }
  if (process.platform !== 'win32' && t.proc.pid) {
    try { process.kill(-t.proc.pid, signal); return true; } catch { /* shell 已退出时回退到进程句柄 */ }
  }
  try { return t.proc.kill(signal); } catch { return false; }
}

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
  const defaultShell = process.platform === 'win32'
    ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
    : (process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'));
  const sh = String(shell || defaultShell);
  // 未选择项目时仍可打开终端；落在用户主目录，而非打包应用的 resources 目录。
  const dir = cwd || homedir();
  const proc = spawn(sh, process.platform === 'win32' ? ['/Q'] : ['-i'], {
    cwd: dir,
    env: { ...process.env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
    // 独立进程组：Ctrl+C 与关闭终端都必须作用于正在执行的子命令，
    // 不能只结束 shell 而留下 sleep/build 等孤儿进程。
    detached: process.platform !== 'win32',
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

  // shell 结束与 HTTP 写入竞态时可能产生 EPIPE；作为已退出处理而非让服务崩溃。
  proc.stdin?.on('error', () => {});
  proc.on('error', (e) => {
    t.exited = true; t.exit_at = Date.now(); t.code = -1;
    broadcast(t, { type: 'exit', code: -1, error: e?.message || String(e) });
    t.subs.clear();
  });
  proc.on('close', (code, signal) => {
    if (t.exited) return;
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
  if (!t.proc.stdin?.writable) return false;
  t.last_active = Date.now();
  // xterm 的 Enter 发出 CR；管道 shell 按 LF 读取命令。服务端也归一化，
  // 让旧前端和直接使用 API 的客户端都能正常执行。
  try { t.proc.stdin.write(data.replace(/\r\n?/g, '\n')); return true; }
  catch { return false; }
}

export function interruptTerminal(id) {
  const t = terminals.get(id);
  if (!t || t.exited || process.platform === 'win32') return false;
  t.last_active = Date.now();
  return signalTerminal(t, 'SIGINT');
}

export function killTerminal(id, reason) {
  const t = terminals.get(id);
  if (!t || t.exited) return false;
  t.kill_reason = reason || null;
  signalTerminal(t, 'SIGTERM');
  const hard = setTimeout(() => { if (!t.exited) signalTerminal(t, 'SIGKILL'); }, 2000);
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
      signalTerminal(t, 'SIGKILL');
      t.exited = true; t.exit_at = now;
      terminals.delete(id);
    }
  }
}

// 惰性清扫：unref 保证不阻塞进程退出（测试进程可自然结束）
setInterval(sweep, 60_000).unref();
