// 持久 shell 会话：一条长驻 shell + 哨兵分隔符
//
// 为什么需要：`spawn(shell, ['-c', cmd])` 每次都是全新进程，`cd` / `export` /
// `source venv/bin/activate` 一律不保留，跨多步的构建流程根本走不通。
//
// 实现：长驻一条 `$SHELL -i`（加载用户 rc，所以 PATH/nvm/conda 都在），
// 每次执行把命令写进 stdin，再写一行哨兵 `printf '__VEGA_DONE_<nonce>__%s|%s\n' "$?" "$PWD"`。
// 读到哨兵行即认为本次命令结束，同时拿到退出码与命令后的 $PWD
// （所以 `cd` 会真实影响后续所有工具的工作目录）。
//
// 失败兜底：shell 起不来 / 超时 / 进程死掉 → 自动回退一次性 spawn，
// 保证 Bash 工具在任何环境下都可用。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildChildEnv } from '../security.js';

const DEFAULT_TIMEOUT = 120000;
const MAX_BUFFER = 200000; // 单次命令的缓冲上限（与旧实现保持一致）

/** 常驻 shell 实例（按 cwd 维度复用） */
const shells = new Map();

function shellPath() {
  return process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh');
}

function spawnOptions(cwd) {
  return {
    cwd,
    env: buildChildEnv(process.env, {
      // 让交互式 shell 别打提示符、别写历史、别用花哨的 zle 渲染，
      // 否则输出里会混进一堆控制字符。
      PS1: '', PS2: '', PROMPT: '', PROMPT2: '', RPROMPT: '',
      TERM: 'dumb', PROMPT_EOL_MARK: '', VEGA_SHELL: '1'
    }),
    stdio: ['pipe', 'pipe', 'pipe']
  };
}

/** 交互式 shell 的启动噪声（主题提示符、ANSI 序列、CR）都要洗掉 */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[=>]/g;

export function cleanShellOutput(s) {
  return String(s ?? '')
    .replace(ANSI_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n');
}

/**
 * 关掉 shell 每次渲染提示符的钩子。
 * 单纯把 PS1 置空是不够的：oh-my-zsh / p10k / starship 这类主题是在
 * precmd 钩子里**每次**重设 PROMPT 的，所以必须把钩子清掉。
 */
const QUIET_PREAMBLE =
  'precmd_functions=(); preexec_functions=(); chpwd_functions=(); ' +
  "PROMPT=''; PS1=''; PS2=''; PROMPT2=''; RPROMPT=''; " +
  'unsetopt PROMPT_SP PROMPT_CR PROMPT_SUBST 2>/dev/null; unset HISTFILE\n';

class PersistentShell {
  constructor(cwd) {
    this.cwd = cwd;
    this.buf = '';
    this.pending = null; // { marker, resolve, timer, chunks, truncated }
    this.dead = false;
    this.cold = true;    // 首条命令用短超时探测：起不来就立刻回退一次性执行
    this.proc = spawn(shellPath(), ['-i'], spawnOptions(cwd));
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', (d) => this._onData(d));
    this.proc.on('error', () => this._die());
    this.proc.on('exit', () => this._die());
    // 静音 rc 输出（含主题的 precmd 钩子）+ 固定提示符；同时把 cwd 拉到期望值
    this._write(QUIET_PREAMBLE);
    this._write(`cd ${JSON.stringify(cwd)} 2>/dev/null || true\n`);
  }

  _write(s) {
    try { this.proc.stdin.write(s); } catch { this._die(); }
  }

  _die() {
    this.dead = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve({
        exitCode: -1,
        output: cleanShellOutput(this.buf) + '\n[shell 会话已断开，已回退到一次性执行模式]',
        broken: true
      });
      this.pending = null;
    }
  }

  /** 丢弃当前缓冲（用于首次启动时吞掉 rc 的噪声输出） */
  _drain() {
    this.buf = '';
  }

  /** 底层执行：写命令 + 哨兵，等哨兵行返回 */
  _runRaw(command, timeoutMs, signal) {
    if (this.dead) return Promise.resolve({ broken: true, exitCode: -1, output: '' });
    if (signal?.aborted) {
      return Promise.resolve({ exitCode: -1, output: '[命令已被用户中止]', aborted: true });
    }
    const marker = `__VEGA_DONE_${randomBytes(8).toString('hex')}__`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending) return;
        this.pending = null;
        // 命令可能挂住了（等 stdin / 死循环）：杀掉整条 shell，下次重建。
        try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({
          exitCode: -1,
          output: cleanShellOutput(this.buf) + `\n[命令超时 ${timeoutMs}ms，已终止 shell 会话]`,
          timedOut: true,
          // 只有冷启动握手超时才让上层"改用一次性执行"；正常命令超时
          // 不该被重跑一遍（那会把一条慢命令执行两次）。
          broken: this.cold
        });
      }, Math.max(1000, timeoutMs));
      // 用户点停止：立即杀掉整条 shell 并收尾。不带 broken —— broken 会让
      // 上层用一次性执行把同一条命令重跑一遍，等于中止失效。
      const onAbort = () => {
        if (!this.pending) return;
        clearTimeout(timer);
        this.pending = null;
        try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({
          exitCode: -1,
          output: cleanShellOutput(this.buf) + '\n[命令已被用户中止]',
          aborted: true
        });
      };
      if (signal) {
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending = { marker, resolve, timer };
      this._write(`${command}\nprintf '${marker}%s|%s\\n' "$?" "$PWD"\n`);
    });
  }

  /**
   * 执行一条命令。
   * 冷启动时先做一次握手（`:`），把 rc / 主题在首个提示符里吐出的噪声
   * 连同握手输出一起丢掉 —— 否则第一次调用的输出里会混进
   * `user@host dir %` 这类提示符。
   */
  async run(command, timeoutMs, signal) {
    if (this.dead) return { broken: true, exitCode: -1, output: '' };
    if (this.cold) {
      const warm = await this._runRaw(':', Math.min(timeoutMs, 8000));
      if (warm.aborted) return warm;
      if (warm.timedOut || warm.broken) return warm; // 上层回退一次性执行
      this.cold = false;
    }
    return this._runRaw(command, timeoutMs, signal);
  }

  _onData(chunk) {
    this.buf += chunk;
    if (this.buf.length > MAX_BUFFER * 2) {
      this.buf = this.buf.slice(-MAX_BUFFER);
      if (this.pending) this.pending.truncated = true;
    }
    if (!this.pending) {
      // 没有等待中的命令时，缓冲只留最后一小段，避免无限增长
      if (this.buf.length > 8192) this.buf = this.buf.slice(-4096);
      return;
    }
    const idx = this.buf.indexOf(this.pending.marker);
    if (idx < 0) return;
    const after = this.buf.slice(idx + this.pending.marker.length);
    const nl = after.indexOf('\n');
    if (nl < 0) return; // 哨兵行还没收全

    const meta = after.slice(0, nl);          // "<exit>|<pwd>"
    const output = cleanShellOutput(this.buf.slice(0, idx));
    this.buf = after.slice(nl + 1);

    const { resolve, timer, marker, truncated } = this.pending;
    this.pending = null;
    clearTimeout(timer);

    const sep = meta.indexOf('|');
    const exitCode = Number(sep >= 0 ? meta.slice(0, sep) : meta);
    const pwd = sep >= 0 ? meta.slice(sep + 1).trim() : this.cwd;
    if (pwd) this.cwd = pwd;
    this.cold = false; // 握手成功：后续命令用完整超时
    resolve({
      exitCode: Number.isFinite(exitCode) ? exitCode : -1,
      output,
      cwd: pwd || this.cwd,
      truncated
    });
  }

  dispose() {
    this.dead = true;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

/** 拿到（或创建）cwd 对应的常驻 shell */
export function acquireShell(cwd) {
  let sh = shells.get(cwd);
  if (sh && !sh.dead) return sh;
  if (sh) shells.delete(cwd);
  try {
    sh = new PersistentShell(cwd);
  } catch {
    return null;
  }
  shells.set(cwd, sh);
  return sh;
}

/** 用后即弃的 shell（持久模式不可用时回退） */
export function runOnce(command, cwd, timeoutMs, signal) {
  return new Promise((resolve) => {
    const proc = spawn(shellPath(), ['-c', command], {
      cwd,
      env: buildChildEnv(process.env),
      timeout: timeoutMs
    });
    let out = '';
    let truncated = false;
    let aborted = false;
    const onData = (d) => {
      out += d;
      if (out.length > MAX_BUFFER) { truncated = true; proc.kill(); }
    };
    const onAbort = () => { aborted = true; try { proc.kill('SIGKILL'); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => resolve({ exitCode: -1, output: `执行失败: ${e.message}` }));
    proc.on('close', (code, csig) => {
      // spawn 的 timeout 选项到点会 SIGTERM，退出码是 null —— 说清楚原因，
      // 否则模型看到 `exit_code: null` 会以为命令"成功但没有输出"。
      const timedOut = !aborted && code === null && (csig === 'SIGTERM' || csig === 'SIGKILL');
      resolve({
        exitCode: code,
        output: aborted ? `[命令已被用户中止]\n${out}` : timedOut ? `[命令超时 ${timeoutMs}ms，已终止]\n${out}` : out,
        truncated,
        timedOut,
        aborted
      });
    });
  });
}

/** 关掉某目录的常驻 shell（工作目录变更 / 运行结束时调用） */
export function releaseShell(cwd) {
  const sh = shells.get(cwd);
  if (sh) { sh.dispose(); shells.delete(cwd); }
}

/** 关掉所有常驻 shell（进程退出保护） */
export function disposeAllShells() {
  for (const [, sh] of shells) sh.dispose();
  shells.clear();
}

let exitHookInstalled = false;
/** 进程退出时别留孤儿 shell */
export function installShellExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const bye = () => { try { disposeAllShells(); } catch { /* ignore */ } };
  process.once('exit', bye);
  process.once('SIGINT', () => { bye(); process.exit(130); });
}
