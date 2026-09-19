// Git 深度集成面板：分支 / 工作树 / 暂存提交 / 日志
//
// 与变更预览（DiffPanel）互补：DiffPanel 只看 diff，这里管分支与工作树。
// 工作树的「切换会话到此」会把 session.cwd 改成工作树路径，之后所有工具
// 都在那个工作树里跑 —— 这是 worktree 并行开发的核心用法。

import { GitBranch, Plus, RefreshCw, Trash2, GitCommit, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { sessionApi } from '@/api';
import { gitApi, type GitBranch as Branch, type GitCommit as CommitRow, type GitStatusFiles, type GitWorktree } from '@/api/git';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useI18n';

interface GitPanelProps {
	agentId: string | null;
	sessionId: string | null;
	cwd: string | null;
}

export function GitPanel({ agentId, sessionId, cwd }: GitPanelProps) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const [branches, setBranches] = useState<Branch[]>([]);
	const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
	const [status, setStatus] = useState<GitStatusFiles | null>(null);
	const [commits, setCommits] = useState<CommitRow[]>([]);
	const [loading, setLoading] = useState(false);

	// 各小节的局部输入态
	const [newBranch, setNewBranch] = useState('');
	const [fromBranch, setFromBranch] = useState('');
	const [wtBranch, setWtBranch] = useState('');
	const [commitMsg, setCommitMsg] = useState('');

	const refresh = useCallback(async () => {
		if (!sessionId) return;
		setLoading(true);
		try {
			const [b, w, s, l] = await Promise.all([
				gitApi.branches(sessionId),
				gitApi.worktrees(sessionId),
				gitApi.statusFiles(sessionId),
				gitApi.log(sessionId, 15),
			]);
			setBranches(b.branches);
			setWorktrees(w.worktrees);
			setStatus(s);
			setCommits(l.commits);
		} catch {
			/* 非 git 仓库或后端无此端点 → 静默空状态 */
		} finally {
			setLoading(false);
		}
	}, [sessionId]);

	useEffect(() => {
		void refresh();
	}, [refresh, cwd]);

	// 没工作目录就不渲染 —— 与 TerminalPanel 一致的空状态
	if (!cwd || !sessionId || !agentId) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pb-2 text-center text-[11px] text-muted-foreground">
				<GitBranch className="size-5" />
				{zh ? '先选择工作目录，再打开 Git 面板。' : 'Select a workspace before opening the Git panel.'}
			</div>
		);
	}

	const run = async (label: string, fn: () => Promise<unknown>) => {
		try {
			await fn();
			toast.success(label);
			void refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};

	// 把会话 cwd 切到某个工作树路径
	const switchSessionToWt = async (path: string) => {
		try {
			await sessionApi.update(sessionId, agentId, { cwd: path });
			toast.success(zh ? '已切换到工作树' : 'Switched to worktree');
			void refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 pb-2 text-[11px]">
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground">{cwd}</span>
				<Button variant="ghost" size="icon-sm" onClick={() => void refresh()} aria-label={zh ? '刷新' : 'Refresh'}>
					{loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
				</Button>
			</div>

			{/* ── 分支 ── */}
			<Section title={zh ? '分支' : 'Branches'}>
				<div className="flex gap-1">
					<Input
						value={newBranch}
						onChange={(e) => setNewBranch(e.target.value)}
						placeholder={zh ? '新分支名' : 'New branch name'}
						className="h-7 text-[11px]"
					/>
					<Input
						value={fromBranch}
						onChange={(e) => setFromBranch(e.target.value)}
						placeholder={zh ? '起点（可空）' : 'Start point (optional)'}
						className="h-7 w-24 text-[11px]"
					/>
					<Button
						size="sm"
						onClick={() => {
							if (!newBranch.trim()) return;
							void run(zh ? '分支已创建' : 'Branch created', () => gitApi.createBranch(sessionId, newBranch.trim(), fromBranch.trim() || undefined));
							setNewBranch('');
							setFromBranch('');
						}}
					>
						<Plus className="size-3" /> {zh ? '建' : 'Create'}
					</Button>
				</div>
				<div className="flex flex-col gap-0.5">
					{branches.map((b) => (
						<div key={b.name} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
							<span className={b.current ? 'font-medium' : 'text-muted-foreground'}>
								{b.current ? '● ' : '○ '}{b.name}
							</span>
							{b.ahead != null && b.behind != null && (b.ahead > 0 || b.behind > 0) ? (
								<span className="text-[10px] text-muted-foreground">
									↑{b.ahead} ↓{b.behind}
								</span>
							) : null}
							<span className="ml-auto flex gap-0.5">
								{!b.current ? (
									<Button variant="ghost" size="icon-sm" onClick={() => void run(zh ? '已切换' : 'Switched', () => gitApi.switchBranch(sessionId, b.name))}>
										<GitCommit className="size-3" />
									</Button>
								) : null}
								{!b.current ? (
									<Button variant="ghost" size="icon-sm" onClick={() => void run(zh ? '已删除' : 'Deleted', () => gitApi.deleteBranch(sessionId, b.name, true))}>
										<Trash2 className="size-3" />
									</Button>
								) : null}
							</span>
						</div>
					))}
				</div>
			</Section>

			{/* ── 工作树 ── */}
			<Section title={zh ? '工作树' : 'Worktrees'}>
				<div className="flex gap-1">
					<Input
						value={wtBranch}
						onChange={(e) => setWtBranch(e.target.value)}
						placeholder={zh ? '新工作树 + 分支名' : 'New worktree + branch'}
						className="h-7 text-[11px]"
					/>
					<Button
						size="sm"
						onClick={() => {
							if (!wtBranch.trim()) return;
							// 工作树放在仓库同级的 .cocode-wt/<branch>，不污染仓库内
							const base = cwd.replace(/\/$/, '');
							const path = `${base.substring(0, base.lastIndexOf('/'))}/.cocode-wt/${wtBranch.trim()}`;
							void run(zh ? '工作树已创建' : 'Worktree created', () => gitApi.createWorktree(sessionId, path, wtBranch.trim()));
							setWtBranch('');
						}}
					>
						<Plus className="size-3" /> {zh ? '建' : 'Create'}
					</Button>
				</div>
				<div className="flex flex-col gap-0.5">
					{worktrees.map((w, i) => (
						<div key={w.path + i} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted">
							<span className="truncate text-muted-foreground" title={w.path}>
								{w.branch ?? '(detached)'}
							</span>
							<span className="ml-auto flex gap-0.5">
								<Button variant="ghost" size="sm" onClick={() => void switchSessionToWt(w.path)}>
									{zh ? '切换会话到此' : 'Switch session here'}
								</Button>
								<Button variant="ghost" size="icon-sm" onClick={() => void run(zh ? '工作树已移除' : 'Worktree removed', () => gitApi.removeWorktree(sessionId, w.path, true))}>
									<Trash2 className="size-3" />
								</Button>
							</span>
						</div>
					))}
				</div>
			</Section>

			{/* ── 暂存与提交 ── */}
			<Section title={zh ? '暂存与提交' : 'Stage & commit'}>
				<div className="flex gap-1">
					<Button size="sm" variant="outline" onClick={() => void run(zh ? '已暂存全部' : 'All staged', () => gitApi.stage(sessionId, []))}>{zh ? '暂存全部' : 'Stage all'}</Button>
					<Button size="sm" variant="outline" onClick={() => void run(zh ? '已取消暂存' : 'Unstaged all', () => gitApi.unstage(sessionId, []))}>{zh ? '取消暂存' : 'Unstage all'}</Button>
				</div>
				{status ? (
					<div className="flex flex-col gap-0.5 font-mono text-[10px]">
						{status.staged.map((f) => (
							<div key={'s' + f.path} className="text-green-600 dark:text-green-400">{f.status}  {f.path}</div>
						))}
						{status.unstaged.map((f) => (
							<div key={'u' + f.path} className="text-yellow-600 dark:text-yellow-400">{f.status}  {f.path}</div>
						))}
						{status.untracked.map((f) => (
							<div key={'n' + f} className="text-blue-600 dark:text-blue-400">??  {f}</div>
						))}
						{!status.staged.length && !status.unstaged.length && !status.untracked.length ? (
							<div className="text-muted-foreground">{zh ? '工作区干净' : 'Working tree clean'}</div>
						) : null}
					</div>
				) : null}
				<div className="flex gap-1">
					<Input
						value={commitMsg}
						onChange={(e) => setCommitMsg(e.target.value)}
						placeholder={zh ? '提交信息' : 'Commit message'}
						className="h-7 text-[11px]"
					/>
					<Button
						size="sm"
						onClick={() => {
							if (!commitMsg.trim()) return;
							void run(zh ? '已提交' : 'Committed', () => gitApi.commit(sessionId, commitMsg.trim()));
							setCommitMsg('');
						}}
					>
						<GitCommit className="size-3" /> {zh ? '提交' : 'Commit'}
					</Button>
				</div>
			</Section>

			{/* ── 日志 ── */}
			<Section title={zh ? '最近提交' : 'Recent commits'}>
				<div className="flex flex-col gap-0.5 font-mono text-[10px]">
					{commits.map((c) => (
						<div key={c.sha} className="truncate" title={c.subject}>
							<span className="text-muted-foreground">{c.sha}</span> {c.subject}
						</div>
					))}
				</div>
			</Section>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
			{children}
		</div>
	);
}
