import type { ToolResultBlock } from '@agentscope-ai/agentscope/message';
import { Ban, Check, ChevronRight, LoaderCircle, Minus, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ToolCallWithResult } from './types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/utils/common.ts';

export function ToolStateIcon({ state }: { state: ToolResultBlock['state'] | undefined }) {
	if (state === 'success') {
		return <Check className="size-3 text-emerald-600 dark:text-emerald-400 shrink-0" />;
	}
	if (state === 'error') {
		return <X className="size-3 text-red-600 dark:text-red-400  shrink-0" />;
	}
	if (state === 'interrupted' || state === 'denied') {
		return <Ban className="size-3 !h-3 min-h-3 shrink-0" />;
	}

	// running
	return <LoaderCircle className="size-3 shrink-0 animate-spin" />;
}

/**
 * Flatten a tool result's ``output`` (string or block array) into plain text,
 * keeping only the text blocks. Returns ``''`` when the result is missing.
 */
export function getResultText(result?: ToolResultBlock): string {
	if (!result) return '';
	if (typeof result.output === 'string') return result.output;
	if (Array.isArray(result.output)) {
		return result.output.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
	}
	return '';
}

/**
 * Shared class for the *leading label* of a tool-call trigger line — the verb
 * or tool name such as "Read", "Bash", "Grep pattern", or the generic
 * "Call tool". Deliberately not bold (no `<strong>`): every tool's label looks
 * the same and only brightens to the foreground colour on row hover (the row
 * is a `group`).
 */
export const toolLabelClass = 'shrink-0 transition-colors group-hover:text-foreground';

/**
 * Shared class for the *primary argument* of a trigger line — the file name
 * (Read/Edit/Write), search pattern (Grep/Glob), task subject (TaskCreate) or,
 * for tools without a dedicated renderer, the tool name itself. Unifies weight
 * and truncation so the second slot is visually identical across every tool.
 */
export const toolArgClass =
	'font-[450] min-w-0 truncate transition-colors group-hover:text-foreground';

/**
 * One collapsible tool-call row — the single shared shell every tool renders
 * through. The trigger line is ``{header}  <state-icon>  <chevron>``; the
 * chevron only appears on hover and stays visible (rotated down) while open.
 * When ``body`` is provided the row expands to reveal it; without a body the
 * row is a plain, non-expandable line (no chevron, no pointer cursor).
 *
 * ``header`` should be a fragment of inline flex children (the parent supplies
 * ``gap-x-2``); tools never touch the Collapsible / state icon themselves.
 */
export function ToolCallRow({
	pair,
	header,
	body,
}: {
	pair: ToolCallWithResult;
	header: ReactNode;
	body?: ReactNode;
}) {
	const expandable = body != null && body !== false;
	// NOTE: never put the ``shimmer`` util on this row wrapper. It is a
	// text-clip effect that sets ``-webkit-text-fill-color: transparent`` and
	// paints the glyphs with an animated gradient — and that property is
	// **inherited**. On a wrapper there is no text of its own to paint, so the
	// gradient lands on nothing while every descendant label turns invisible,
	// leaving a blank slot next to the chevron (an SVG, drawn with stroke, so it
	// stays visible). The running state is carried by ``ToolStateIcon`` below,
	// which already spins — that is the cue, not a shimmer.
	const row = (
		<div
			className={cn(
				'group flex flex-row gap-x-2 items-center w-full',
				expandable && 'cursor-pointer',
			)}
		>
			{header}
			<ToolStateIcon state={pair.result?.state} />
			{expandable && (
				<ChevronRight
					className={
						'size-3 shrink-0 transition-transform text-transparent group-hover:text-current group-data-[state=open]:flex group-data-[state=open]:rotate-90'
					}
				/>
			)}
		</div>
	);

	if (!expandable) return row;

	return (
		<Collapsible>
			<CollapsibleTrigger asChild>{row}</CollapsibleTrigger>
			{/* 用 grid-template-rows 0fr ↔ 1fr 做高度 auto 的平滑过渡（CSS 动画对 height:auto 无效）。
			    容器必须设 display:grid，CollapsibleContent 内部子元素溢出隐藏。 */}
			<CollapsibleContent className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out data-[state=open]:grid-rows-[1fr] [&[data-state=open]>div]:overflow-visible [&>div]:overflow-hidden">
				<div className="min-h-0">{body}</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * Aggregate state for a *collapsed* tool-call group, so the fold can show a
 * single state icon: spinner while anything is still running, otherwise
 * error > interrupted > success. ``undefined`` means running (see ToolStateIcon).
 */
export function groupToolState(
	calls: ToolCallWithResult[],
): ToolResultBlock['state'] | undefined {
	if (calls.some((c) => !c.result || c.result.state === 'running')) return undefined;
	if (calls.some((c) => c.result?.state === 'error')) return 'error';
	if (calls.some((c) => c.result?.state === 'interrupted' || c.result?.state === 'denied')) {
		return 'interrupted';
	}
	return 'success';
}

/**
 * Parse the input arguments from the given string.
 * @param input
 * @returns The JSON Record or empty object if parsing fails.
 */
export function parseInput(input: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(input);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Get the filepath from the input arguments.
 * @param input
 * @returns The filepath, or ``undefined`` when ``input`` isn't yet a complete
 * JSON object carrying a non-empty ``file_path`` — a tool call's arguments
 * stream in as partial JSON, and a fragment of ``content`` must never pass for
 * a path.
 */
export function tryGetFilePath(input: string): string | undefined {
	const { file_path } = parseInput(input) as { file_path?: unknown };
	return typeof file_path === 'string' && file_path.length > 0 ? file_path : undefined;
}

/**
 * The basename of ``file_path``, or ``undefined`` while the tool-call JSON is
 * still streaming. Use this in ``renderHeader`` so a partial input renders no
 * file name rather than a garbled one.
 * @param input
 * @returns The filename, considering different OS path separators.
 */
export function tryGetFileName(input: string): string | undefined {
	const filePath = tryGetFilePath(input);
	if (!filePath) return undefined;
	const segments = filePath.split(/[/\\]+/).filter(Boolean);
	return segments.length > 0 ? segments[segments.length - 1] : filePath;
}

/**
 * Tally inserted / deleted lines from a unified diff text. The leading
 * ``+++`` / ``---`` lines (file headers) are excluded.
 */
export function countDiffStats(diffText: string): {
	insertions: number;
	deletions: number;
} {
	let insertions = 0;
	let deletions = 0;
	for (const line of diffText.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) insertions++;
		else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
	}
	return { insertions, deletions };
}

/**
 * Extract the ``diff`` field from a ToolResultBlock metadata bag, returning
 * ``undefined`` when missing or empty so callers can use it with ``??``.
 */
export function getResultDiff(result: { metadata?: Record<string, unknown> }): string | undefined {
	const diff = result.metadata?.diff;
	return typeof diff === 'string' && diff.length > 0 ? diff : undefined;
}

export interface ChangedFileEntry {
	/** 去重键：工具输入里的完整路径 */
	path: string;
	/** 路径末段，列表行展示用 */
	name: string;
	/** 文件名以外的目录部分，弱化展示 */
	dir: string;
	/** 该文件所有成功写入累计新增行数 */
	added: number;
	/** 该文件所有成功写入累计删除行数 */
	removed: number;
	/** 最后一次写入产生的 unified diff（行内展开预览用） */
	diff: string;
}

function splitPath(path: string): { name: string; dir: string } {
	const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return idx >= 0
		? { name: path.slice(idx + 1), dir: path.slice(0, idx) }
		: { name: path, dir: '' };
}

/**
 * 聚合一条消息里成功的 Write/Edit 调用产生的文件改动，供回合结束的
 * 「文件更改」卡片展示。
 * - 只统计 result.state === 'success' 的调用（被拒绝/中断的写入没有真实改动）；
 * - 路径兼容 `path` 与 `file_path` 两种参数名（core 的 Write/Edit 用 `path`，
 *   tryGetFilePath 等既有工具函数与部分历史数据用 `file_path`）；
 * - 同一文件多次编辑按路径去重，增删行数累计，diff 保留最后一次的
 *   （最新 diff 的行号基线已包含此前编辑，和 git 的累计视图一致）。
 */
export function collectChangedFiles(calls: ToolCallWithResult[]): ChangedFileEntry[] {
	const byPath = new Map<string, ChangedFileEntry>();
	for (const { call, result } of calls) {
		if (call.name !== 'Write' && call.name !== 'Edit') continue;
		if (!result || result.state !== 'success') continue;
		const input = parseInput(call.input) as { path?: unknown; file_path?: unknown };
		const path =
			typeof input.path === 'string' && input.path.length > 0
				? input.path
				: typeof input.file_path === 'string' && input.file_path.length > 0
					? input.file_path
					: undefined;
		if (!path) continue;
		const { name, dir } = splitPath(path);
		const diff = getResultDiff(result);
		const stats = diff ? countDiffStats(diff) : { insertions: 0, deletions: 0 };
		const prev = byPath.get(path);
		byPath.set(path, {
			path,
			name,
			dir,
			added: (prev?.added ?? 0) + stats.insertions,
			removed: (prev?.removed ?? 0) + stats.deletions,
			diff: diff ?? prev?.diff ?? '',
		});
	}
	return Array.from(byPath.values());
}

/**
 * Framed body box shared by file-oriented tools (Read / Edit / Write): a
 * bordered card with the file path as a header, a separator, then the tool's
 * own content (numbered source lines for Read, a diff for Edit / Write).
 */
export function FramedFileBody({ filePath, children }: { filePath?: string; children: ReactNode }) {
	return (
		<div className="flex flex-col border rounded-sm bg-background">
			{filePath && (
				<>
					<div className="px-2 py-1 whitespace-nowrap overflow-x-auto">{filePath}</div>
					<Separator />
				</>
			)}
			{children}
		</div>
	);
}

/**
 * Compact ``+N -M`` badge used in tool call headers for Edit / Write to show
 * how many lines were inserted and deleted.
 */
export function DiffStats({
	insertions,
	deletions,
	className,
}: {
	/** Optional: a backend that predates these fields simply won't send them. */
	insertions?: number;
	deletions?: number;
	className?: string;
}) {
	const ins = insertions ?? 0;
	const del = deletions ?? 0;
	if (ins === 0 && del === 0) return null;
	return (
		<div className={cn('flex items-center gap-0.5', className)}>
			<div className="flex items-center text-emerald-600 dark:text-emerald-400">
				<Plus className="size-2.5 stroke-2" />
				{formatNumber(ins)}
			</div>

			<div className="flex items-center text-red-600 dark:text-red-400">
				<Minus className="size-2.5 stroke-2" />
				{formatNumber(del)}
			</div>
		</div>
	);
}
