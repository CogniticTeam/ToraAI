import { ReplyFinishedReason } from '@agentscope-ai/agentscope/event';
import type {
	ContentBlock,
	DataBlock,
	Msg,
	TextBlock,
	ThinkingBlock,
	ToolCallBlock,
	ToolResultBlock,
} from '@agentscope-ai/agentscope/message';
import { motion } from 'framer-motion';
import {
	Check,
	ChevronRight,
	CirclePlay,
	Copy,
	Diamond,
	FileText,
	FileVideo2,
	Info,
	TriangleAlert,
} from 'lucide-react';
import { Sparkles } from 'lucide-react';
import * as mime from 'mime-types';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { renderToolCall } from './tool-renderers';
import {
	countDiffStats,
	collectChangedFiles,
	DiffStats,
	getResultDiff,
	groupToolState,
	ToolStateIcon,
} from './tool-renderers/_shared';
import { ChangedFilesCard } from './tool-renderers/ChangedFilesCard';
import type { TFunction, ToolCallWithResult } from './tool-renderers/types';
import { Markdown } from '@/components/markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
	Attachment,
	AttachmentContent,
	AttachmentDescription,
	AttachmentGroup,
	AttachmentMedia,
	AttachmentTitle,
} from '@/components/ui/attachment.tsx';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar.tsx';
import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble.tsx';
import { Button } from '@/components/ui/button';
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@/components/ui/collapsible.tsx';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { Message, MessageFooter, MessageContent } from '@/components/ui/message';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAudioBlock, useReplayController } from '@/context/AudioContext';
import { useSkills } from '@/hooks/useSkills';
import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';
import { copyToClipboard, formatTime } from '@/utils/common';
import 'streamdown/styles.css';

/**
 * A run of *consecutive* tool calls (of any name) collapsed into a single
 * container, each call paired to its result. The one aggregated summary/fold
 * renders here; every call inside is dispatched to its dedicated per-tool
 * renderer via `renderToolCall`.
 */
interface ToolCallGroupBlock {
	type: 'tool_call_group';
	calls: ToolCallWithResult[];
	created_at?: string;
	finished_at?: string;
}

type ExtendedContentBlock = ContentBlock | ToolCallGroupBlock;

/**
 * Pair every tool_call with its tool_result (by id) and collect *consecutive*
 * tool calls into a single `tool_call_group`, regardless of tool name — so a
 * run like `[Read, Read, Edit, some_mcp_tool]` becomes one collapsible
 * container. Non-tool blocks (text, thinking, data, ...) break the run and
 * pass through unchanged at their original position.
 *
 * Results may arrive after their calls — concurrent tool use lays content out
 * as `[call_A, call_B, result_A, result_B]` — so calls are paired by id in a
 * first pass before the run is assembled.
 */
function groupToolCalls(content: ContentBlock[]): ExtendedContentBlock[] {
	// Pass 1: pair calls ↔ results by id; remember non-tool blocks in order.
	const callMap = new Map<string, ToolCallWithResult>();
	const orphanResults: ToolResultBlock[] = [];
	const ordering: Array<{ type: 'tool'; id: string } | { type: 'other'; block: ContentBlock }> =
		[];

	for (const block of content) {
		if (block.type === 'tool_call') {
			callMap.set(block.id, { call: block });
			ordering.push({ type: 'tool', id: block.id });
		} else if (block.type === 'tool_result') {
			const matching = callMap.get(block.id);
			if (matching) matching.result = block;
			else orphanResults.push(block);
		} else {
			ordering.push({ type: 'other', block });
		}
	}

	// Pass 2: walk the ordering, accumulating consecutive calls into one group.
	const result: ExtendedContentBlock[] = [];
	let current: ToolCallWithResult[] = [];
	const flush = () => {
		if (current.length === 0) return;
		result.push({ type: 'tool_call_group', calls: current });
		current = [];
	};

	for (const item of ordering) {
		if (item.type === 'other') {
			flush();
			result.push(item.block);
		} else {
			const entry = callMap.get(item.id);
			if (entry) current.push(entry);
		}
	}
	flush();

	// Orphan results (no matching call) — surface each as its own group.
	for (const block of orphanResults) {
		result.push({
			type: 'tool_call_group',
			calls: [
				{
					call: {
						type: 'tool_call',
						id: block.id,
						name: block.name,
						input: '',
						state: 'finished' as const,
						created_at: block.created_at,
						finished_at: block.finished_at,
					},
					result: block,
				},
			],
		});
	}

	return result;
}

const AUDIO_WAVE_LINES: Array<{ x: number; y1: number; y2: number }> = [
	{ x: 2, y1: 10, y2: 13 },
	{ x: 6, y1: 6, y2: 17 },
	{ x: 10, y1: 3, y2: 21 },
	{ x: 14, y1: 8, y2: 15 },
	{ x: 18, y1: 5, y2: 18 },
	{ x: 22, y1: 10, y2: 13 },
];

function AudioWave({ isPlaying = true, className }: { isPlaying?: boolean; className?: string }) {
	return (
		<>
			{isPlaying && (
				<style>{`
					@keyframes audioWave {
						0%, 100% { transform: scaleY(1); }
						50%      { transform: scaleY(0.3); }
					}
				`}</style>
			)}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="24"
				height="24"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={2}
				strokeLinecap="round"
				strokeLinejoin="round"
				className={className}
			>
				{AUDIO_WAVE_LINES.map(({ x, y1, y2 }, i) => (
					<line
						key={x}
						x1={x}
						x2={x}
						y1={y1}
						y2={y2}
						style={{
							transformOrigin: `${x}px 12px`,
							animation: isPlaying
								? `audioWave 0.8s ease-in-out ${i * 0.12}s infinite`
								: 'none',
						}}
					/>
				))}
			</svg>
		</>
	);
}

/**
 * Inline audio control rendered *inside* the time/usage Badge so the play
 * icon visually merges into the same chip rather than floating as its own
 * pill.
 */
function AudioInlineControl({ block }: { block: DataBlock }) {
	const { t } = useTranslation();
	const audioState = useAudioBlock(block.id);
	const replayController = useReplayController();
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);

	const isStreaming = audioState?.status === 'streaming';

	// Don't build the giant base64 data URL while bytes are still streaming —
	// it would re-allocate on every DATA_BLOCK_DELTA. Live playback during
	// that window is handled by the manager's WavStreamPlayer; we only need
	// `src` for replay after the stream ends (or for historical messages).
	let src: string | null = null;
	if (!isStreaming) {
		if (audioState?.url) {
			src = audioState.url;
		} else if (block.source.type === 'url') {
			src = block.source.url;
		} else if (block.source.type === 'base64' && block.source.data) {
			src = `data:${block.source.media_type};base64,${block.source.data}`;
		}
	}

	// Reset the hidden <audio> when the source URL changes (e.g. streaming
	// just transitioned to a Blob URL). Without an explicit load() some
	// browsers keep the previous (or empty) source bound to the element.
	useEffect(() => {
		const el = audioRef.current;
		if (!el || !src) return;
		setIsPlaying(false);
		el.load();
	}, [src]);

	// Pause when a newer reply interrupts this block's playback.
	const interruptCount = audioState?.interruptCount ?? 0;
	useEffect(() => {
		if (interruptCount === 0) return;
		const el = audioRef.current;
		if (el && !el.paused) {
			el.pause();
		}
	}, [interruptCount]);

	if (isStreaming) {
		return <AudioWave isPlaying className="ml-1" />;
	}

	if (!src) return null;

	const toggle = async () => {
		const el = audioRef.current;
		if (!el) return;
		if (el.paused) {
			replayController?.play(el);
			try {
				await el.play();
			} catch (err) {
				console.error('Audio playback failed', err);
			}
		} else {
			el.pause();
			replayController?.stop();
		}
	};

	return (
		<>
			<button
				type="button"
				onClick={toggle}
				aria-label={
					isPlaying ? t('messageBubble.pauseAudio') : t('messageBubble.playAudio')
				}
				className="ml-1 inline-flex cursor-pointer items-center transition-opacity hover:opacity-70"
			>
				{isPlaying ? (
					<AudioWave isPlaying className="size-3" />
				) : (
					<CirclePlay className="size-3" />
				)}
			</button>
			<audio
				ref={audioRef}
				src={src}
				preload="auto"
				onPlay={() => setIsPlaying(true)}
				onPause={() => setIsPlaying(false)}
				onEnded={() => setIsPlaying(false)}
			/>
		</>
	);
}

/**
 * Copies the message's text to the clipboard, flipping to a check mark
 * for a moment so the click has visible feedback. It remains visible so
 * the action is always discoverable.
 */
function CopyButton({ text }: { text: string }) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		if (!(await copyToClipboard(text))) return;
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<Button
			variant="ghost"
			size="icon-xs"
			className="text-muted-foreground"
			tooltip={t('messageBubble.copy')}
			aria-label={t('messageBubble.copy')}
			onClick={handleCopy}
		>
			{copied ? <Check /> : <Copy />}
		</Button>
	);
}

/** 对话完成后，在悬停消息时显示本地发送时间。 */
function MessageTimestamp({ value }: { value: string }) {
	const timestamp = new Date(value);
	if (Number.isNaN(timestamp.getTime())) return null;
	const hour = String(timestamp.getHours()).padStart(2, '0');
	const minute = String(timestamp.getMinutes()).padStart(2, '0');
	return <time dateTime={value} className="tabular-nums text-[11px] font-normal">{hour}:{minute}</time>;
}

/** 首个回复事件抵达前的紧凑状态提示，放在用户消息的时间之前。 */
function ThinkingStatus() {
	const { t } = useTranslation();
	return (
		<span className="inline-flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground" role="status" aria-live="polite">
			<span className="flex gap-0.5" aria-hidden>
				<span className="size-1 animate-pulse rounded-full bg-current [animation-delay:-300ms]" />
				<span className="size-1 animate-pulse rounded-full bg-current [animation-delay:-150ms]" />
				<span className="size-1 animate-pulse rounded-full bg-current" />
			</span>
			{t('chat.thinking')}
		</span>
	);
}

const MCP_TOOL_PREFIX = 'mcp__';

// Task-management tools are all surfaced under one "updated todos" summary.
const TODO_TOOLS = new Set(['TaskGet', 'TaskUpdate', 'TaskList', 'TaskCreate']);

/**
 * Bucket a group's calls into per-category counts and total inserted/deleted
 * lines (from Edit/Write result diffs), then build the localized collapsible
 * title. Categories are appended in a fixed order — Bash, Read, Edit/Write,
 * Search (Grep/Glob), Todo, MCP — each omitted when its count is zero. If
 * nothing matches a known category, a generic "called N tools" fallback is used.
 */
function summarizeToolGroup(calls: ToolCallWithResult[], t: TFunction) {
	let nBash = 0;
	let nRead = 0;
	let nEdit = 0;
	let nSearch = 0;
	let nTodo = 0;
	let nMCP = 0;
	let insertions = 0;
	let deletions = 0;

	for (const { call, result } of calls) {
		const name = call.name;
		if (name === 'Bash') {
			nBash += 1;
		} else if (name === 'Read') {
			nRead += 1;
		} else if (name === 'Edit' || name === 'Write') {
			nEdit += 1;
			// Sum the real +/- line changes from the backend-provided diff.
			const diff = result ? getResultDiff(result) : undefined;
			if (diff) {
				const stats = countDiffStats(diff);
				insertions += stats.insertions;
				deletions += stats.deletions;
			}
		} else if (name === 'Grep' || name === 'Glob') {
			nSearch += 1;
		} else if (TODO_TOOLS.has(name)) {
			nTodo += 1;
		} else if (name.startsWith(MCP_TOOL_PREFIX)) {
			nMCP += 1;
		}
	}

	const parts: string[] = [];
	if (nBash > 0) parts.push(t('tool.summary.bash', { count: nBash }));
	if (nRead > 0) parts.push(t('tool.summary.read', { count: nRead }));
	if (nEdit > 0) parts.push(t('tool.summary.edit', { count: nEdit }));
	if (nSearch > 0) parts.push(t('tool.summary.search', { count: nSearch }));
	if (nTodo > 0) parts.push(t('tool.summary.todo', { count: nTodo }));
	if (nMCP > 0) parts.push(t('tool.summary.mcp', { count: nMCP }));

	const joined =
		parts.length > 0
			? parts.join(t('tool.summary.separator'))
			: t('tool.summary.fallback', { count: calls.length });
	// Sentence-case only the very first letter (each i18n part is lower-cased
	// so commas don't introduce mid-sentence capitals in English; a no-op for
	// scripts without letter case such as Chinese).
	const title = joined.length > 0 ? joined[0].toUpperCase() + joined.slice(1) : joined;

	return { title, insertions, deletions };
}

interface MessageBubbleProps {
	message: Msg;
	/** 首个 assistant 内容块到达前，紧贴用户消息展示的等待状态。 */
	showThinking?: boolean;
	/** 仅在本轮完成后允许显示时间；实际显示仍由消息悬停触发。 */
	showTimestamp?: boolean;
	onUserConfirm: (
		toolCallBlock: ToolCallBlock,
		confirm: boolean,
		replyId: string,
		rules?: ToolCallBlock['suggested_rules'],
	) => void;
}

/**
 * A message bubble component that displays a chat message.
 *
 * The assistant footer shows a 「已处理 x天x时x分xx秒」 elapsed-time label
 * (ticking once per second while the reply streams, frozen once
 * REPLY_END lands) plus the copy button — but the copy button only
 * appears *after* the reply finished (`finished_reason` set), so a
 * half-streamed answer can't be copied in its incomplete state.
 * Audio-playback controls still render there when the message carries
 * audio blocks, and only then.
 *
 * When `content` is empty and the message is still running, the bubble
 * body is omitted entirely.
 */
function ASMessageBubbleComponent({
	message,
	showThinking = false,
	showTimestamp = false,
}: MessageBubbleProps) {
	const isUser = message.role === 'user';
	const { t } = useTranslation();
	const { skills: library } = useSkills();

	// 系统提示条（role=system，如「模型已从 X 更改为 Y」）：居中分隔线样式，
	// 不渲染成气泡。放在 hooks 之后、其余渲染之前，保证不破坏条件一致性。
	const systemText = message.role === 'system'
		? message.content
			.filter((b): b is TextBlock => b.type === 'text')
			.map((b) => b.text)
			.join('\n')
		: null;

	// Read the skill ids the user attached at send time. Resolved against
	// the live library so names match what they saw in the input — the
	// bubble can be re-rendered after a rename without a stale label.
	const selectedSkills = useMemo(() => {
		if (!isUser) return [];
		const m = (message as Msg & { metadata?: Record<string, unknown> }).metadata;
		const ids = Array.isArray(m?.selected_skill_ids) ? (m.selected_skill_ids as string[]) : null;
		if (!ids || ids.length === 0) return [];
		const byId = new Map(library.map((s) => [s.id, s]));
		return ids
			.map((id) => byId.get(id))
			.filter((s): s is NonNullable<typeof s> => Boolean(s));
	}, [isUser, library, message]);

	// hooks 规则：system 分支提前 return，因此上方所有 hooks（含
	// useTranslation/useSkills/useMemo）必须无条件先执行完，此处返回
	// 才不会造成渲染间 hooks 数量不稳定。
	if (message.role === 'system') {
		const meta = (message as Msg & { metadata?: Record<string, unknown> }).metadata;
		return (
			<motion.div
				initial={{ opacity: 0, y: 4 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.18 }}
			>
				<Marker variant="separator" className="my-4 text-xs font-normal text-muted-foreground">
					<MarkerContent className="inline-flex items-center gap-1.5">
						<span>{systemText}</span>
						{meta?.kind === 'model_switch' && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Info className="size-3 opacity-60 hover:opacity-100" />
								</TooltipTrigger>
								<TooltipContent side="top" className="max-w-xs font-normal">
									{t('common.model-switch-warning')}
								</TooltipContent>
							</Tooltip>
						)}
					</MarkerContent>
				</Marker>
			</motion.div>
		);
	}

	// Audio data blocks are rendered in the footer;
	// For role="user" messages, the data blocks are rendered as attachments in the
	// footer, while for role="assistant" messages, the data is rendered in its
	// original position
	const audioBlocks = message.content.filter(
		(b): b is DataBlock => b.type === 'data' && b.source.media_type.split('/')[0] === 'audio',
	);

	const blocks = groupToolCalls(message.content);

	// 回合结束后的文件改动汇总（仅成功的 Write/Edit）。流式中 finished_reason
	// 尚未写入，与复制按钮同一判据；无改动则得到空数组、卡片不渲染。
	const changedFiles =
		!isUser && message.finished_reason
			? collectChangedFiles(
					blocks.flatMap((b) => (b.type === 'tool_call_group' ? b.calls : [])),
				)
			: [];

	// What the copy button hands over — the prose of the message, without
	// the tool calls and attachments around it.
	const plainText = message.content
		.filter((b): b is TextBlock => b.type === 'text')
		.map((b) => b.text)
		.join('\n\n');

	// 本条回复累计消耗的积分：官方模型由 core 写入 metadata.credits
	// （流式中经 credits_changed 事件实时同步）。自定义模型无此字段，不展示。
	const bubbleMeta = (message as Msg & { metadata?: Record<string, unknown> }).metadata;
	const creditsUsed =
		typeof bubbleMeta?.credits === 'number' && bubbleMeta.credits > 0
			? bubbleMeta.credits
			: null;
	const timestamp = showTimestamp ? (
		<span className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
			<MessageTimestamp value={message.created_at} />
		</span>
	) : null;

	return (
		<motion.div
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
		>
			<Message align={isUser ? 'end' : 'start'} data-role={message.role}>
			<MessageContent>
				{/* Selected-skill chip row — mirrors what the user attached before
				    sending. Reads `metadata.selected_skill_ids` set by useMessages.send. */}
				{selectedSkills.length > 0 && (
					<div className="mb-2 flex flex-wrap justify-end gap-1.5">
						{selectedSkills.map((s) => (
							<Badge
								key={s.id}
								variant="glass"
								className="h-7 gap-1 rounded-rect pl-1 pr-3 text-[12px]"
								aria-label={t('messageBubble.skillAttached', { name: s.display_name || s.name })}
							>
								<Avatar className="size-5 rounded">
									<AvatarImage src={s.icon_url ?? undefined} alt={s.display_name || s.name} loading="lazy" />
									<AvatarFallback className="rounded text-[10px]">
										{(s.display_name || s.name).slice(0, 1).toUpperCase()}
									</AvatarFallback>
								</Avatar>
								<Sparkles className="size-3 text-primary" />
								<span className="font-medium">{s.display_name || s.name}</span>
							</Badge>
						))}
					</div>
				)}
				{blocks
					.filter((block) => block.type !== 'data')
					.map((block, index) => (
						<Bubble key={index} variant={isUser ? 'tinted' : 'ghost'}>
							<BubbleContent>
								<ASBlock block={block} />
							</BubbleContent>
						</Bubble>
					))}
				{changedFiles.length > 0 && <ChangedFilesCard files={changedFiles} />}
				{message.finished_reason === ReplyFinishedReason.ERROR && (
					<Alert
						variant="destructive"
						className="m-2 w-[calc(100%-1rem)] border-red-200 bg-red-50 text-destructive dark:border-red-900 dark:bg-red-950 dark:text-red-50"
					>
						<TriangleAlert />
						<AlertTitle>{t('messageBubble.error.title')}</AlertTitle>
						<AlertDescription>
							{(() => {
								const raw = message.error?.message?.trim();
								if (raw) return raw;
								return t(`messageBubble.error.${message.error?.type ?? 'unknown'}`, {
									defaultValue: t('messageBubble.error.unknown'),
								});
							})()}
						</AlertDescription>
					</Alert>
				)}
				<AttachmentGroup className="max-w-full">
					{blocks
						.filter((block) => block.type === 'data')
						.map((block, index) => (
							<ASBlock block={block} key={index} />
						))}
				</AttachmentGroup>
				{message.role === 'user' ? (
					// 让状态、时间与复制紧贴用户气泡底边；时间和复制均按悬停
					// 出现，避免静态界面在每条用户消息下堆积操作控件。
					<MessageFooter className="-mt-2 gap-1.5 py-0">
						{showThinking && <ThinkingStatus />}
						{timestamp}
						{plainText && (
							<span className="opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
								<CopyButton text={plainText} />
							</span>
						)}
					</MessageFooter>
				) : (
					<MessageFooter className="gap-1.5 font-mono">
						{timestamp}
						{/* 播放控件只在消息带音频块时出现。 */}
						{audioBlocks.length > 0 && (
							<div className="flex items-center gap-1.5">
								{audioBlocks.map((block) => (
									<AudioInlineControl key={block.id} block={block} />
								))}
							</div>
						)}
						{/* 复制按钮只在回复结束后出现 —— 流式输出中的半截
						    文本没有复制价值，反而会引导用户复制到残缺内容。 */}
						{plainText && message.finished_reason && (
							<span className="opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
								<CopyButton text={plainText} />
							</span>
						)}
						{/* 官方模型本条回复累计消耗的积分（复制按钮右侧） */}
						{creditsUsed !== null && (
							<span className="pointer-events-none inline-flex items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
								{t('common.creditsUsed')}
								<Diamond className="size-3" />
								{creditsUsed}
							</span>
						)}
					</MessageFooter>
				)}
			</MessageContent>
		</Message>
		</motion.div>
	);
}

/**
 * Memoised: a streaming reply publishes a new `Msg` object on every delta
 * (see ``useMessages``) while the messages around it keep their identity,
 * so only the bubble that actually changed re-renders. A message mutated
 * in place would therefore *not* repaint — new content has to arrive as a
 * new object.
 */
export const ASMessageBubble = memo(ASMessageBubbleComponent);

/**
 * A thinking block with a live-ticking "thinking for Xs" header. Kept as its
 * own component so only thinking blocks pay for the per-second timer.
 */
function ThinkingBlockView({ block }: { block: ThinkingBlock }) {
	const { t } = useTranslation();
	const isRunning = !block.finished_at;

	// Tick once per second while running so the elapsed time updates live.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!isRunning) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [isRunning]);

	const startMs = new Date(block.created_at).getTime();
	const endMs = isRunning ? now : new Date(block.finished_at!).getTime();
	const elapsedSeconds = Math.max(0, (endMs - startMs) / 1000);
	const elapsedText = formatTime(elapsedSeconds);
	return (
		<Collapsible>
			<CollapsibleTrigger asChild>
				{/* shimmer 只能加在真正承载文字的元素上 —— 它会设
				    -webkit-text-fill-color: transparent 并用渐变当字色，而这个属性
				    会被子元素继承。加在外层容器上等于把整块文字变透明（容器自己没有
				    文字可画），界面看起来就是个空位。 */}
				<div className="group w-full flex items-center gap-2 text-left text-sm text-muted-foreground cursor-pointer">
					<span className={cn(isRunning && 'shimmer')}>
						{t(
							elapsedText === '0s'
								? 'messageBubble.thinking'
								: 'messageBubble.thinkingFor',
							{ duration: elapsedText },
						)}
					</span>
					<ChevronRight className="hidden group-hover:flex group-data-[state=open]:flex size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
				</div>
			</CollapsibleTrigger>
			<CollapsibleContent asChild>
				<Markdown
					animated
					isAnimating={isRunning}
					className="text-muted-foreground bg-muted p-2 rounded text-sm"
				>
					{block.thinking}
				</Markdown>
			</CollapsibleContent>
		</Collapsible>
	);
}

interface ASBlockProps {
	block: ExtendedContentBlock;
}

export function ASBlock({ block, ...props }: ASBlockProps) {
	const { t } = useTranslation();

	switch (block.type) {
		case 'text':
			return (
				<Markdown animated isAnimating={!block.finished_at} {...props}>
					{block.text}
				</Markdown>
			);
		case 'data': {
			const dataType = block.source.media_type.split('/')[0];
			if (dataType === 'audio') return null;
			const data =
				block.source.type === 'url'
					? block.source.url
					: `data:${block.source.media_type};base64,${block.source.data}`;
			switch (dataType) {
				case 'image':
					return (
						<Attachment>
							<AttachmentMedia variant={'image'}>
								<img src={data} alt={block.name || 'Uploaded image'} />
							</AttachmentMedia>
							<AttachmentContent>
								<AttachmentTitle>{block.name}</AttachmentTitle>
								<AttachmentDescription>
									{(
										mime.extension(block.source.media_type) || 'bin'
									).toUpperCase()}
								</AttachmentDescription>
							</AttachmentContent>
						</Attachment>
					);
				case 'video':
					return (
						<Attachment>
							<AttachmentMedia variant={'icon'}>
								<FileVideo2 />
							</AttachmentMedia>
							<AttachmentContent>
								<AttachmentTitle>{block.name}</AttachmentTitle>
								<AttachmentDescription>
									{(
										mime.extension(block.source.media_type) || 'bin'
									).toUpperCase()}
								</AttachmentDescription>
							</AttachmentContent>
						</Attachment>
					);
				default:
					// Unknown files
					return (
						<Attachment>
							<AttachmentMedia variant={'icon'}>
								<FileText />
							</AttachmentMedia>
							<AttachmentContent>
								<AttachmentTitle>{block.name}</AttachmentTitle>
								<AttachmentDescription>
									{(
										mime.extension(block.source.media_type) || 'bin'
									).toUpperCase()}
								</AttachmentDescription>
							</AttachmentContent>
						</Attachment>
					);
			}
		}
		case 'thinking':
			return <ThinkingBlockView block={block} />;
		case 'hint': {
			// Parse source: try JSON, fall back to plain string, default to t('common.message').
			let hintLabel: string;
			let hintSublabel: string | null = null;

			if (block.source) {
				try {
					const parsed = JSON.parse(block.source) as {
						label?: string;
						sublabel?: string;
					};
					// Both halves go through the same i18n table, falling
					// back to the raw text for sources it doesn't cover.
					hintLabel = parsed.label
						? t(`messageBubble.hintSource.${parsed.label.toLowerCase()}`, {
								defaultValue: parsed.label,
							})
						: block.source;
					hintSublabel = parsed.sublabel
						? t(
								`messageBubble.hintSource.${parsed.sublabel.toLowerCase().replace(/\s+/g, '_')}`,
								{ defaultValue: parsed.sublabel },
							)
						: null;
				} catch {
					hintLabel = block.source;
				}
			} else {
				hintLabel = t('common.message');
			}
			const items: (TextBlock | DataBlock)[] =
				typeof block.hint === 'string'
					? [
							{
								type: 'text',
								id: `${block.id}-text`,
								text: block.hint,
								created_at: block.created_at,
							},
						]
					: block.hint;
			return (
				<Collapsible>
					<CollapsibleTrigger asChild>
						<div className="group w-full flex gap-2 items-center text-sm text-muted-foreground cursor-pointer hover:text-primary">
							{/* shimmer 放在持有文字的 span 上，不要放外层容器（见 ThinkingBlockView 的说明） */}
							<span className={cn(!block.finished_at && 'shimmer')}>
								{hintLabel + (hintSublabel ? ` - ${hintSublabel}` : '')}
							</span>
							<ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
						</div>
					</CollapsibleTrigger>
					<CollapsibleContent className="bg-muted p-2 rounded text-sm">
						{items.map((item, index) => (
							<ASBlock block={item} key={index} />
						))}
					</CollapsibleContent>
				</Collapsible>
			);
		}
		case 'tool_call_group': {
			const { title, insertions, deletions } = summarizeToolGroup(block.calls, t);
			return (
				<Collapsible defaultOpen={false}>
					<CollapsibleTrigger asChild>
						{/* 折叠行是运行中唯一可见的东西，所以它必须自己说明状态：
						    有工具在跑就转圈（ToolStateIcon 收到 undefined 时就是 spinner），
						    跑完再换成对勾/叉。此前这里挂的是容器级 shimmer —— 那既没有
						    转圈，又把整行文字刷成透明，只剩一个箭头，看起来就是个空位。 */}
						<div className="group w-full flex gap-2 items-center text-sm text-muted-foreground cursor-pointer hover:text-primary">
							<span>{title}</span>
							<ToolStateIcon state={groupToolState(block.calls)} />
							<ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
							<DiffStats insertions={insertions} deletions={deletions} />
						</div>
					</CollapsibleTrigger>
					<CollapsibleContent className="flex flex-col w-full gap-y-1 bg-muted p-2 rounded text-sm text-muted-foreground">
						{block.calls.map((pair) => renderToolCall(pair, t))}
					</CollapsibleContent>
				</Collapsible>
			);
		}

		default:
			return null;
	}
}
