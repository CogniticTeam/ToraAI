// Git 深度集成：分支 / 工作树 / 暂存 / 提交 / 日志
//
// 与 tools/git.js 的分工：git.js 是「给 Agent 用的透传 git 工具 + 轻量状态探测」；
// 本文件是「给前端 Git 面板用的结构化高层 API」—— 返回前端能直接渲染的对象，
// 不让前端自己解析 `git branch -vv` 那种充满格式陷阱的输出。
//
// 全部走 runGit（spawn、参数数组、不经 shell）。写操作（除了提交）不做 destructive
// 兜底检查 —— destructive 防护在 tools/git.js 的 Agent 工具层；面板是用户显式操作。
import { runGit } from './git.js';

/**
 * 分支列表。解析 `git branch -vv`，每条带 name / current / ahead / behind /
 * upstream / subject（最近一次提交的标题）。
 * ahead/behind 与 readGitInfo 一致：没配 upstream 时为 null（"不知道"），不是 0。
 */
export async function listBranches(cwd) {
  const r = await runGit(['branch', '-vv'], cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git branch 失败').trim() };
  const branches = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    // 格式: `* main  abc1234 [origin/main: ahead 1, behind 2] subject`
    //         `  dev   def5678 subject`
    const m = /^(\*| )\s+(\S+)\s+([0-9a-f]+)\s*(?:\[([^\]]+)\])?\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, star, name, sha, upstream, subject] = m;
    let ahead = null, behind = null, upstreamName = null;
    if (upstream) {
      const up = upstream.split(':');
      upstreamName = up[0].trim();
      if (up[1]) {
        const am = /ahead\s+(\d+)/.exec(up[1]);
        const bm = /behind\s+(\d+)/.exec(up[1]);
        if (am) ahead = Number(am[1]);
        if (bm) behind = Number(bm[1]);
      } else {
        // 只有 upstream 名，没有 ahead/behind → 说明齐平
        ahead = 0; behind = 0;
      }
    }
    branches.push({ name, current: star === '*', sha, upstream: upstreamName, ahead, behind, subject: subject.trim() });
  }
  return { ok: true, branches };
}

/** 新建分支（不切换）。from 可省略 = 从当前 HEAD 起。 */
export async function createBranch(cwd, name, from) {
  const args = ['branch', name];
  if (from) args.push(from);
  const r = await runGit(args, cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || '创建分支失败').trim() };
  return { ok: true };
}

/**
 * 切换分支。工作区有未提交改动时 git switch 会拒绝 —— 这里不自动 stash，
 * 把 stderr 原样返回给前端让用户决定（提交 / 丢弃 / 取消）。
 */
export async function switchBranch(cwd, name) {
  const r = await runGit(['switch', name], cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || '切换分支失败').trim() };
  return { ok: true };
}

/** 删除分支。force=true 时用 -D（即使未合并）。 */
export async function deleteBranch(cwd, name, force = false) {
  const r = await runGit(['branch', force ? '-D' : '-d', name], cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || '删除分支失败').trim() };
  return { ok: true };
}

/** 工作树列表：解析 `git worktree list --porcelain`。 */
export async function listWorktrees(cwd) {
  const r = await runGit(['worktree', 'list', '--porcelain'], cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git worktree list 失败').trim() };
  const list = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (cur && line.startsWith('detached')) {
      cur.detached = true;
    } else if (cur && line.startsWith('bare')) {
      cur.bare = true;
    } else if (cur && line.startsWith('locked')) {
      cur.locked = true;
    } else if (cur && line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  if (cur) list.push(cur);
  return { ok: true, worktrees: list };
}

/**
 * 新建工作树 + 新分支。
 * - path: 工作树的绝对路径（前端一般传 repo 旁边的 .cocode-wt/<branch>）
 * - branch: 要创建并检出的新分支名
 * - from: 可选，新分支的起点（commit/分支），省略 = 当前 HEAD
 */
export async function createWorktree(cwd, path, branch, from) {
  if (!path || !branch) return { ok: false, error: '需要 path 和 branch' };
  const args = ['worktree', 'add', '-b', branch, path];
  if (from) args.push(from);
  const r = await runGit(args, cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || '创建工作树失败').trim() };
  return { ok: true };
}

/** 移除工作树。force=true 时即使有未提交改动也强制移除（改动会丢失）。 */
export async function removeWorktree(cwd, path, force = false) {
  const args = ['worktree', 'remove', path];
  if (force) args.push('--force');
  const r = await runGit(args, cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || '移除工作树失败').trim() };
  return { ok: true };
}

/** 暂存文件。paths 为空数组时 = `git add -A`（暂存全部）。 */
export async function stageFiles(cwd, paths = []) {
  const args = ['add'];
  if (!paths.length) args.push('-A');
  else args.push(...paths.map(String));
  const r = await runGit(args, cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git add 失败').trim() };
  return { ok: true };
}

/** 取消暂存（从 index 撤回）。paths 为空时 = `git restore --staged .`。 */
export async function unstageFiles(cwd, paths = []) {
  const args = ['restore', '--staged'];
  if (!paths.length) args.push('.');
  else args.push(...paths.map(String));
  const r = await runGit(args, cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || '取消暂存失败').trim() };
  return { ok: true };
}

/** 暂存区状态：staged / unstaged / untracked 文件清单（带状态码 XY）。 */
export async function statusFiles(cwd) {
  const r = await runGit(['status', '--porcelain=v1'], cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git status 失败').trim() };
  const staged = [], unstaged = [], untracked = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0], y = line[1];
    const path = line.slice(3).trim();
    if (!path) continue;
    if (x === '?' && y === '?') { untracked.push(path); continue; }
    if (x !== ' ' && x !== '?') staged.push({ path, status: x });
    if (y !== ' ' && y !== '?') unstaged.push({ path, status: y });
  }
  return { ok: true, staged, unstaged, untracked };
}

/** 提交。message 不能为空。自动设置 user.name/email 兜底（仓库未配置时）。 */
export async function commit(cwd, message) {
  if (!message || !String(message).trim()) return { ok: false, error: '提交信息不能为空' };
  // 兜底：仓库/全局没配 user 时用占位，否则 git commit 直接失败
  const identify = await runGit(['config', 'user.name'], cwd);
  const args = [];
  if (!identify.ok || !identify.stdout.trim()) {
    args.push('-c', 'user.name=cocode', '-c', 'user.email=cocode@local');
  }
  args.push('commit', '-m', String(message));
  const r = await runGit(args, cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || '提交失败（可能暂存区为空）').trim() };
  return { ok: true };
}

/** 最近 N 条提交。 */
export async function log(cwd, limit = 20) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 200));
  // %h 短SHA %s 标题 %an 作者 %ad 相对时间
  const r = await runGit(['log', `-${n}`, '--pretty=format:%h|%s|%an|%ar'], cwd);
  if (!r.ok) return { ok: false, error: (r.stderr || 'git log 失败').trim() };
  const commits = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, author, rel] = line.split('|');
    return { sha, subject, author, relative: rel };
  });
  return { ok: true, commits };
}
