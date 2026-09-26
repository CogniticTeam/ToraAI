import { FileDiff, GitCompare } from 'lucide-react';
import { useMemo } from 'react';

import { PanelEmpty } from '@/components/panel/PanelEmpty';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

interface DiffPanelProps {
	/** Raw `git diff` output. Empty when the tree is clean. */
	diff: string;
	/** Set when git itself could not answer (not a repo, no workspace). */
	error: string | null;
	errorCode?: 'not_git_repository' | 'git_unavailable' | 'git_diff_failed' | null;
	loading: boolean;
	onRefresh: () => void;
	/** Repository root, shown in the header when known. */
	root?: string | null;
}

/**
 * Colourises a unified diff one line at a time.
 *
 * Deliberately not a diff *parser*: the panel's job is to let the user see
 * what the agent is about to leave behind, and line-level colour plus the
 * header stats cover that. Structural diffing (moved blocks, intra-line
 * changes) would cost far more code than it earns here.
 *
 * @param diff - Raw unified diff text.
 * @returns Total added/removed line counts.
 */
function countChanges(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++') || line.startsWith('---')) continue;
		if (line.startsWith('+')) added++;
		else if (line.startsWith('-')) removed++;
	}
	return { added, removed };
}

function DiffLine({ line }: { line: string }) {
	const tone = line.startsWith('+++') || line.startsWith('---')
		? 'text-muted-foreground font-medium'
		: line.startsWith('@@')
			? 'text-sky-600 dark:text-sky-400'
			: line.startsWith('+')
				? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950'
				: line.startsWith('-')
					? 'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950'
					: line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')
						? 'text-muted-foreground'
						: '';
	return (
		<div className={cn('whitespace-pre px-2 leading-relaxed', tone)}>
			{line || ' '}
		</div>
	);
}

/**
 * The working tree's diff against HEAD, refreshed on demand and after
 * every finished reply.
 *
 * Read-only on purpose: this exists so that "先看改动再决定" is possible
 * without running a tool. Committing, stashing and checking out stay in the
 * agent's hands (or the terminal's) — a panel that can rewrite the tree is
 * a much bigger thing to get right.
 *
 * @param diff - Raw unified diff.
 * @param error - Why git could not answer, when it could not.
 * @returns The panel body (no header chrome — `Panel` draws that).
 */
export function DiffPanel({ diff, error, errorCode, loading, onRefresh, root }: DiffPanelProps) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const stats = useMemo(() => countChanges(diff), [diff]);
	// 兼容尚未重启的旧后端：不要把 Git 的用法说明整段塞进侧栏。
	const notRepo = errorCode === 'not_git_repository' || Boolean(error?.includes('Not a git repository'));
	const description = notRepo
		? (zh ? '选择 Git 项目后即可查看变更。' : 'Select a Git project to preview changes.')
		: errorCode === 'git_unavailable'
			? (zh ? 'Git 不可用，请检查系统 Git 安装。' : 'Git is unavailable. Check your Git installation.')
			: errorCode === 'git_diff_failed' || !error || error.length > 200
				? (zh ? '无法读取 Git 改动，请稍后重试。' : 'Could not read Git changes. Please try again.')
				: error;

	if (error || errorCode) {
		return (
			<PanelEmpty
				icon={GitCompare}
				title={notRepo ? (zh ? '当前文件夹不是 Git 仓库' : 'This folder is not a Git repository') : (zh ? '拿不到改动' : 'Unable to read changes')}
				description={description}
				className="border-0"
			/>
		);
	}

	if (!diff.trim()) {
		return (
			<PanelEmpty
				icon={FileDiff}
				title={loading ? (zh ? '读取中…' : 'Loading…') : (zh ? '工作区没有未提交的改动' : 'No uncommitted changes')}
				description={zh ? 'Agent 改完文件后，这里会显示它到底改了什么。' : 'Changes made by the agent will appear here.'}
			/>
		);
	}

	return (
		<div className="flex flex-1 flex-col gap-1.5 min-h-0">
			<div className="flex items-center gap-x-2 px-1 py-1 text-xs text-muted-foreground">
				{root ? <span className="truncate font-mono">{root}</span> : null}
				<span className="ml-auto flex items-center gap-x-1">
					<Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">
						+{stats.added}
					</Badge>
					<Badge variant="outline" className="text-rose-600 dark:text-rose-400">
						-{stats.removed}
					</Badge>
				</span>
				<Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
					{zh ? '刷新' : 'Refresh'}
				</Button>
			</div>
			<div className="flex-1 overflow-auto rounded-md border bg-muted py-1 font-mono text-xs">
				{diff.split('\n').map((line, i) => (
					// Diff lines have no stable identity — the same text can repeat
					// verbatim, so position is the only correct key here.
					<DiffLine key={i} line={line} />
				))}
			</div>
		</div>
	);
}
