// Git 工具 + 仓库状态探测
//
// 为什么需要：改了文件没法看 diff、没法一键撤销、没法让模型自己开分支 ——
// 对写代码的 Agent 来说「先看 diff 再落盘」是基本信任机制。
//
// 实现：零依赖，直接 spawn `git`（参数数组，不经过 shell，避免注入）。
// 只放行已知子命令；写类子命令（add/commit/checkout/reset/...）在权限层
// 归到 write 类，会被 default / explore 模式拦下。
import { spawn } from 'node:child_process';
import { redact } from '../security.js';

const GIT_TIMEOUT = 20000;

/** 只读子命令：不改变仓库状态 */
export const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame',
  'shortlog', 'describe', 'remote', 'tag', 'stash', 'config', 'diff-tree',
  'name-rev', 'check-ignore', 'grep', 'cat-file', 'worktree'
]);

/** 写类子命令：改变仓库/工作区状态 */
export const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'rm', 'mv', 'clean',
  'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'apply', 'am', 'init',
  'tag', 'branch', 'push', 'pull', 'fetch', 'clone', 'config', 'worktree', 'submodule'
]);

/** `stash` / `branch` / `tag` / `config` / `worktree` 既可读也可写，看参数 */
const AMBIGUOUS_SUBCOMMANDS = new Set(['stash', 'branch', 'tag', 'config', 'worktree']);

/** 出现这些参数就说明是写意图 */
const WRITE_INTENT = new Set([
  'push', 'pop', 'save', 'drop', 'clear', 'apply', 'create', 'add', 'remove',
  'set', 'unset', 'edit', 'rename', 'import', 'prune', 'delete',
  '-d', '-D', '--delete', '-m', '--move', '-c', '-f', '--force'
]);

/** 判定一次 git 调用是否属于写操作（权限分类用） */
export function gitIsWrite(cmd, args = []) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (GIT_WRITE_SUBCOMMANDS.has(cmd) && !AMBIGUOUS_SUBCOMMANDS.has(cmd)) return true;
  if (!AMBIGUOUS_SUBCOMMANDS.has(cmd)) return false;
  if (cmd === 'config') {
    // `git config --get x` 是读；`git config x y` / `--set` 是写
    if (argv.some((a) => a.startsWith('--get') || a.startsWith('--list') || a === '-l')) return false;
    return argv.filter((a) => !a.startsWith('-')).length >= 2 || argv.some((a) => WRITE_INTENT.has(a));
  }
  return argv.some((a) => WRITE_INTENT.has(a) || a.startsWith('--set'));
}

/** 执行一次 git，返回 { ok, code, stdout, stderr } */
export function runGit(args, cwd, { timeout = GIT_TIMEOUT, maxBuffer = 400000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('git', args, { cwd, env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: e?.message || String(e) });
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, timeout);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { if (out.length < maxBuffer) out += d; });
    proc.stderr.on('data', (d) => { if (err.length < maxBuffer) err += d; });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: out, stderr: `git 不可用: ${e.message}` });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out, stderr: err });
    });
  });
}

/**
 * 轻量仓库状态：给 /workspace/status 与 system 上下文用。
 * 刻意只跑 2 条命令（rev-parse 合批 + status），避免大仓库卡顿。
 */
export async function readGitInfo(cwd) {
  if (!cwd) return { is_repo: false, reason: 'no-cwd' };
  // 只问「在不在工作树里、根在哪」。**不要**在这里一起取 `--abbrev-ref HEAD`：
  // 刚 git init 的仓库还没有提交，`rev-parse HEAD` 会 exit 128，整条命令直接失败，
  // 于是新建仓库被误判成"不是仓库"（分支信息从下面的 status --branch 拿，
  // 它天然兼容 "No commits yet on main" 这种状态）。
  const rp = await runGit(['rev-parse', '--is-inside-work-tree', '--show-toplevel'], cwd, { timeout: 6000 });
  if (!rp.ok) return { is_repo: false };
  const [inside, root] = rp.stdout.split('\n').map((s) => s.trim());
  if (inside !== 'true') return { is_repo: false };
  const st = await runGit(['status', '--porcelain=v1', '--branch'], cwd, { timeout: 8000 });
  const lines = st.stdout.split('\n').filter((l) => l.trim());
  let ahead = 0, behind = 0, branch = null, detached = false;
  // `## main...origin/main` 里出现了 `...` 才说明配了 upstream；
  // 没配的话 ahead/behind 无从谈起，报 0 会让界面显示"与远端齐平"这种假事实。
  let hasUpstream = false;
  const files = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const dirtyFiles = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      // "main...origin/main [ahead 1, behind 2]" / "No commits yet on main" /
      // "main" / "HEAD (no branch)"
      let head = line.slice(3).trim();
      hasUpstream = head.includes('...');
      const m = /\[ahead (\d+)(?:, behind (\d+))?\]/.exec(head);
      if (m) { ahead = Number(m[1]) || 0; behind = Number(m[2]) || 0; }
      head = head.replace(/\s*\[.*\]$/, '').replace(/^No commits yet on\s+/, '').trim();
      if (head.startsWith('HEAD (no branch)')) { detached = true; branch = null; }
      else { branch = head.split('...')[0].trim() || null; }
      continue;
    }
    const x = line[0], y = line[1];
    const p = line.slice(3).trim();
    if (p) dirtyFiles.push(p);
    if (x === '?' && y === '?') { files.untracked++; continue; }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { files.conflicted++; continue; }
    if (x !== ' ' && x !== '?') files.staged++;
    if (y !== ' ' && y !== '?') files.unstaged++;
  }
  // 行级增删：`diff HEAD` 含已 staged 的改动；刚 init 的仓库还没有 HEAD，
  // 退回工作区 vs index（否则整条命令失败，统计会永远是 0）。
  let shortstat = await runGit(['diff', 'HEAD', '--shortstat'], cwd, { timeout: 8000 });
  if (!shortstat.ok) shortstat = await runGit(['diff', '--shortstat'], cwd, { timeout: 8000 });
  const insM = /(\d+) insertions?\(\+\)/.exec(shortstat.stdout || '');
  const delM = /(\d+) deletions?\(-\)/.exec(shortstat.stdout || '');
  const insertions = insM ? Number(insM[1]) : 0;
  const deletions = delM ? Number(delM[1]) : 0;

  // HEAD 短 SHA：空仓库没有提交，这条会失败 —— 那就算 null。
  const headRes = await runGit(['rev-parse', '--short', 'HEAD'], cwd, { timeout: 5000 });

  return {
    is_repo: true,
    root,
    branch,
    head: headRes.ok ? (headRes.stdout.trim() || null) : null,
    detached,
    // 没配 upstream 时是 null（"不知道"），而不是 0（"一样多"）
    ahead: hasUpstream ? ahead : null,
    behind: hasUpstream ? behind : null,
    insertions,
    deletions,
    // 扁平字段：前端 GitStatus 读的是 staged/unstaged/untracked/conflicted
    staged: files.staged,
    unstaged: files.unstaged,
    untracked: files.untracked,
    conflicted: files.conflicted,
    dirty: dirtyFiles.length,
    files,
    dirty_files: dirtyFiles.slice(0, 30),
    truncated: dirtyFiles.length > 30
  };
}

const SUBCOMMAND_HELP = Object.keys({ ...Object.fromEntries([...GIT_READ_SUBCOMMANDS].map((s) => [s, 1])), ...Object.fromEntries([...GIT_WRITE_SUBCOMMANDS].map((s) => [s, 1])) }).join(', ');

export const gitTool = {
  name: 'Git',
  description:
    '执行 git 命令（参数直接传数组，不经 shell）。看改动先用 status / diff，撤销用 checkout -- <path> 或 restore <path>。' +
    `常用子命令：${SUBCOMMAND_HELP}。输出过长会截断。`,
  parameters: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', description: 'git 子命令，如 status / diff / log / checkout' },
      args: { type: 'array', items: { type: 'string' }, description: '子命令参数数组，如 ["--stat"] 或 ["--", "src/a.js"]' },
      max_chars: { type: 'number', description: '输出最大字符数（默认沿用工具输出上限）' }
    },
    required: ['subcommand']
  },
  async execute({ subcommand, args = [], max_chars }, ctx) {
    const sub = String(subcommand ?? '').trim();
    if (!sub) return '参数错误：subcommand 不能为空。';
    if (!/^[a-z][a-z-]*$/.test(sub)) return `参数错误：非法子命令 "${sub}"。`;
    if (!GIT_READ_SUBCOMMANDS.has(sub) && !GIT_WRITE_SUBCOMMANDS.has(sub)) {
      return `已拒绝：不支持 git ${sub}（白名单外）。可用：${SUBCOMMAND_HELP}`;
    }
    const argv = Array.isArray(args) ? args.map(String) : [];
    // 逐条拒绝明显的破坏性写法，避免模型"顺手 rm -rf"
    if (sub === 'clean' && argv.some((a) => /-[a-zA-Z]*[fdx]/.test(a))) {
      return '已拒绝：git clean 的 -f/-d/-x 会不可逆删除未跟踪文件。请让用户手动确认后执行。';
    }
    const limit = Number.isFinite(max_chars) ? Math.max(200, Math.min(max_chars, 200000))
      : (ctx?.toolOutputLimit ?? 6000);
    const res = await runGit([sub, ...argv], ctx?.cwd);
    const head = `$ git ${[sub, ...argv].join(' ')}\nexit_code: ${res.code}\n`;
    let body = res.stdout || '';
    if (res.stderr) body += (body ? '\n' : '') + `[stderr]\n${res.stderr}`;
    if (!body) body = '(无输出)';
    if (body.length > limit) body = body.slice(0, Math.floor(limit * 0.8)) + `\n…[输出过长，已截断 ${body.length - Math.floor(limit * 0.8)} 字符]…`;
    return redact(head + body);
  }
};

export const gitTools = [gitTool];
