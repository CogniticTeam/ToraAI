import { ReplyFinishedReason } from '@agentscope-ai/agentscope/event';
import {
	type ContentBlock,
	getContentBlocks,
	type Msg,
	type TextBlock,
	type ToolCallBlock,
} from '@agentscope-ai/agentscope/message';
import {
	GitBranch,
	TriangleAlert,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
	type SlashItem,
	commandsToSlashItems,
	fromLibrary as libraryToSlashItems,
} from './SlashCommandMenu';
import { Button } from '../ui/button';
import { DiffStats } from './tool-renderers/_shared';
import { skillApi, type SkillView, type SkillRecord } from '@/api';
import type { GitStatus } from '@/api';
import type { KnowledgeBaseView, Skill, UserCommand } from '@/api';
import { ASMessageBubble } from '@/components/chat/ASMessageBubble.tsx';
import { ConfirmCard } from '@/components/chat/ConfirmCard.tsx';
import { FlipCard } from '@/components/chat/FlipCard.tsx';
import { TextInput } from '@/components/chat/TextInput.tsx';
import { WorkspacePicker } from '@/components/dialog/WorkspacePicker';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Marker, MarkerContent } from '@/components/ui/marker';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from '@/components/ui/message-scroller.tsx';
import { Spinner } from '@/components/ui/spinner';
import type { ReplyPhase } from '@/hooks/useMessages';
import { useSkills } from '@/hooks/useSkills';
import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

/** How long a load may run before it is worth showing a spinner. */
const SPINNER_DELAY_MS = 150;

/**
 * A gap this long between two messages gets a marker stamping when the
 * conversation resumed — long enough that it *was* resumed, rather than
 * merely paused to read the last reply.
 */
const TIME_MARKER_GAP_MS = 10 * 60 * 1000;

/**
 * Stamp for a resumed conversation. The time alone is enough while the
 * marker and the message above it share a day; once the gap crosses
 * midnight the date has to come with it. Both come from `Intl`, so
 * "Aug 13, 13:03" and "8月13日 13:03" fall out of the active language
 * rather than out of a hand-written pattern per locale.
 */
function markerStamp(at: Date, previous: Date, language: string): string {
	const sameDay = at.toDateString() === previous.toDateString();
	return new Intl.DateTimeFormat(language, {
		...(sameDay ? {} : { month: 'short', day: 'numeric' }),
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).format(at);
}

interface ChatContentProps {
	msgs: Msg[];
	/**
	 * Whether the history for the currently selected session is still on
	 * the wire. Takes precedence over {@link msgs}, which still holds the
	 * *previous* session's messages until the fetch effect clears them.
	 */
	loading?: boolean;
	/**
	 * Reply lifecycle phase from ``useMessages`` — forwarded to
	 * ``TextInput`` so the single send / stop button can pick its
	 * icon, tooltip, disabled state and click handler from one source.
	 */
	phase: ReplyPhase;
	disabled: boolean;
	onSend: (content: ContentBlock[], autoContext?: ContentBlock[], selectedSkills?: SlashItem[]) => void;
	onUserConfirm: (
		toolCall: ToolCallBlock,
		confirm: boolean,
		replyId: string,
		rules?: ToolCallBlock['suggested_rules'],
	) => Promise<void>;
	autoComplete?: (input: string) => string | null;
	className?: string;
	/** Called when the user clicks the stop button. */
	onInterrupt?: () => void;
	/**
	 * Optional content pinned at the bottom of the chat — between the
	 * message scroll area and the text input (e.g. pending subagent HITL
	 * cards on a team leader's view). Rendered below the conversation so
	 * a pending confirmation sits next to the input, where the user is
	 * looking, rather than scrolled off the top.
	 */
	footerSlot?: React.ReactNode;
	/** @see TextInputProps.allowedInputTypes */
	allowedInputTypes: string[];
	/** @see TextInputProps.fileProcessor */
	fileProcessor: (file: File) => Promise<ContentBlock | null>;
	/** Current working directory, relative to the workspace root. */
	cwd: string | null;
	/** 当前目录对应的项目展示名；空态欢迎语会使用它保持项目上下文。 */
	projectName?: string | null;
	/** Persists a new working directory. */
	onCwdChange: (cwd: string | null) => void | Promise<void>;
	/** Git state of {@link cwd}; `null` hides the branch badge entirely. */
	git?: GitStatus | null;
	/** Re-reads the git state, since nothing polls for it. */
	onRefreshGit?: () => void | Promise<void>;
	/** Skills currently attached to this session's workspace, used by the "tools" context source. */
	workspaceSkills?: Skill[];
	/** Knowledge bases visible to the user; used by the "tools" context source. */
	workspaceKnowledgeBases?: KnowledgeBaseView[];
	/**
	 * The user's own slash commands (`~/.cocode/commands/*.md` and
	 * `<cwd>/.cocode/commands/*.md`). They appear above the skills in the
	 * `/` menu; picking one fills the composer with its body.
	 */
	userCommands?: UserCommand[];
	/**
	 * Controls rendered on the right side of the input header row —
	 * to the right of the workspace picker (model selector, permission
	 * mode, …). Owned by the viewport, which holds their state.
	 */
	inputControls?: React.ReactNode;
}

const ChatContentComponent: React.FC<ChatContentProps> = ({
	msgs,
	loading = false,
	phase,
	disabled,
	onSend,
	onUserConfirm,
	autoComplete,
	className,
	onInterrupt,
	footerSlot,
	allowedInputTypes,
	fileProcessor,
	cwd,
	projectName = null,
	onCwdChange,
	git,
	onRefreshGit,
	inputControls,
	workspaceSkills,
	workspaceKnowledgeBases,
	userCommands,
}) => {
	const { t, i18n } = useTranslation();

	// ─────── silent auto-context ───────
	// Each send attaches an "auto_context" block alongside the user's
	// content: cwd + git, the last few turns of this session, and the
	// skills / knowledge bases attached to the workspace. The block goes
	// to the backend as a separate channel — the model sees it, the
	// user's bubble does not. There is no toggle, no chip, no "skip"
	// affordance: the load is invisible by design. The one escape hatch
	// we previously exposed lived on the premise the context was shown;
	// that premise is gone.
	const contextBlocks = useMemo<ContentBlock[]>(() => {
		const sections: string[] = [];

		// Section 1 — workspace + git. The single most useful thing the
		// model needs to ground "the current file" / "this repo".
		{
			const lines: string[] = [];
			if (cwd) lines.push(`- CWD: ${cwd}`);
			else lines.push('- CWD: workspace root');
			if (git) {
				if (git.branch) lines.push(`- Git branch: ${git.branch}`);
				else if (git.head) lines.push(`- Git HEAD: ${git.head.slice(0, 7)}`);
				if (git.ahead || git.behind) {
					lines.push(
						`- Ahead/behind upstream: ${git.ahead ?? 0}/${git.behind ?? 0}`,
					);
				}
				if (git.staged || git.unstaged || git.untracked) {
					lines.push(
						`- Working tree: ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked`,
					);
				}
				if (git.insertions || git.deletions) {
					lines.push(`- Diff vs HEAD: +${git.insertions}/-${git.deletions}`);
				}
			}
			sections.push(lines.join('\n'));
		}

		// Section 2 — last few turns. Captured at *send* time, before any
		// compaction, so the model has a coherent snapshot even mid-summary.
		if (msgs.length > 0) {
			const tail = msgs.slice(-6);
			const fmt = tail
				.map((m) => {
					const text = m.content
						.filter((b: ContentBlock) => b.type === 'text')
						.map((b: ContentBlock & { text?: string }) => b.text ?? '')
						.join(' ')
						.trim();
					if (!text) return null;
					const label = m.role === 'user' ? 'User' : 'Assistant';
					return `${label}: ${text.length > 240 ? text.slice(0, 240) + '…' : text}`;
				})
				.filter((s): s is string => s !== null);
			if (fmt.length) sections.push(fmt.join('\n'));
		}

		// Section 3 — what tools the workspace is wired with.
		{
			const lines: string[] = [];
			const enabledSkills = (workspaceSkills ?? []).map((s) => s.name).filter(Boolean);
			if (enabledSkills.length) lines.push(`- Skills: ${enabledSkills.join(', ')}`);
			const enabledKBs = (workspaceKnowledgeBases ?? [])
				.map((k) => k.name)
				.filter(Boolean);
			if (enabledKBs.length) lines.push(`- Knowledge bases: ${enabledKBs.join(', ')}`);
			if (lines.length) sections.push(lines.join('\n'));
		}

		// Empty when there is nothing useful to add — sending an empty
		// block would still cost a round-trip and a confusing "[Loaded
		// context]" line on the model side. Bail outright.
		if (sections.length === 0) return [];

		const text = `[Loaded context]\n${sections.join('\n\n')}`;
		return [
			{
				id: crypto.randomUUID(),
				type: 'text',
				text,
				created_at: new Date().toISOString(),
			} as TextBlock,
		];
	}, [cwd, git, msgs, workspaceSkills, workspaceKnowledgeBases]);

	// ─────── Skill auto-context ───────
	// The user's installed skills are the items the slash menu offers. We
	// pull the library up here so TextInput stays focused on input, and so
	// the markdown bodies resolve at send time without prop drilling.
	const library = useSkills();
	// Commands first, then skills. They read as two kinds of thing — a
	// command fills the composer, a skill gets attached — so the order is
	// what tells the user which is which before they hover anything.
	const slashItems = useMemo<SlashItem[]>(
		() => [
			...commandsToSlashItems(userCommands ?? []),
			...libraryToSlashItems(library.skills),
		],
		[userCommands, library.skills],
	);
	const skillSpecsRef = React.useRef<Map<string, Promise<SkillView>>>(new Map());
	const getSkillRecord = useCallback((id: string): Promise<SkillRecord | SkillView> => {
		const cache = skillSpecsRef.current;
		let p = cache.get(id);
		if (!p) {
			p = skillApi
				.get(id)
				.catch((e): SkillView => {
					cache.delete(id);
					console.warn('[skill] getSkillRecord failed for', id, e?.message ?? e);
					return {
						id,
						name: id,
						enabled: false,
						display_name: null,
						description: '',
						tags: [],
						author: null,
						icon_url: null,
						url: null,
						hub_id: null,
						card_id: null,
						version: null,
					};
				});
			cache.set(id, p);
		}
		return p;
	}, []);

	/**
	 * Resolve all picked skills (fetches markdown if not cached) and build a
	 * single text block to inject into the LLM-side ``internal`` channel.
	 * Returns ``[]`` when nothing is picked so the caller can skip the merge.
	 *
	 * Markdown-less skills fall back to ``description`` rather than nothing —
	 * the model still benefits from the listing copy.
	 */
	const buildSkillContext = useCallback(
		async (picked: SlashItem[] | undefined): Promise<ContentBlock[]> => {
			if (!picked || picked.length === 0) return [];
			const records = await Promise.all(picked.map((p) => getSkillRecord(p.id)));
			const lines: string[] = [];
			for (let i = 0; i < picked.length; i += 1) {
				const p = picked[i];
				const r = records[i];
				const label = p.display_name || p.name;
				// ``markdown`` exists on SkillRecord (the successful ``skillApi.get``
				// path) but not on the placeholder SkillView returned on failure.
				// The optional-chain keeps the type honest and lets TS narrow.
				const md = (r as SkillRecord).markdown || '';
				lines.push(
					md.trim().length > 0
						? `### ${label}\n\n${md}`
						: `### ${label}\n\n${p.description || '(no description)'}`,
				);
			}
			return [
				{
					id: crypto.randomUUID(),
					type: 'text',
					text: `[Selected skills]\n\n${lines.join('\n\n---\n\n')}`,
					created_at: new Date().toISOString(),
				} as TextBlock,
			];
		},
		[getSkillRecord],
	);

	// 请求触发与 SSE 首个可见块之间存在短暂空窗。用 state 而非 ref 记录流已
	// 开始，既让 React 生命周期可追踪，也避免异步 render 中修改 ref 的竞态。
	const [waitingForFirstResponse, setWaitingForFirstResponse] = useState(false);
	const [observedStreaming, setObservedStreaming] = useState(false);

	// Wrap onSend so the silent context block (cwd/git/turns/tools) plus the
	// picked-skill specs travel together as ``auto_context`` — appended to the
	// user-visible bubble only on the model side, never in the local Msg[] that
	// drives ASMessageBubble.
	const handleSend = useCallback(
		async (blocks: ContentBlock[], pickedSkills?: SlashItem[]) => {
			// 本地状态先于 SSE 生命周期：技能上下文构建、创建首个会话以及
			// 服务端接受 trigger 都可能造成短暂空窗，不能让“思考中”漏掉。
			setWaitingForFirstResponse(true);
			setObservedStreaming(false);
			try {
				const skillCtx = await buildSkillContext(pickedSkills);
				const fullContext = [...contextBlocks, ...skillCtx];
				onSend(blocks, fullContext.length > 0 ? fullContext : undefined, pickedSkills);
			} catch (error) {
				setWaitingForFirstResponse(false);
				throw error;
			}
		},
		[onSend, contextBlocks, buildSkillContext],
	);
	// Only a session that finished loading with nothing in it is empty.
	// Treating "no messages yet" as empty would flash the greeting over
	// every session that does have history.
	const isEmpty = !loading && msgs.length === 0;
	// 从用户消息发出到第一个文本块或工具调用抵达 SSE 之间，模型已有任务
	// 但还没有可渲染内容。仅看最后一条消息，避免历史里旧的 assistant 回复
	// 错误地遮住当前轮的占位提示。
	const tailMessage = msgs[msgs.length - 1];
	const hasFirstAssistantContent =
		tailMessage?.role === 'assistant' && tailMessage.content.length > 0;
	const isWaitingForFirstResponse =
		waitingForFirstResponse ||
		phase === 'streaming' &&
		(!tailMessage ||
			tailMessage.role !== 'assistant' ||
			tailMessage.content.length === 0);
	// REPLY_START 会先插入一个 content 为空的 assistant 消息。占位仍应
	// 挂在本轮用户气泡下方，而不是挂到这个尚无可见内容的 assistant 上。
	const waitingUserMessage = isWaitingForFirstResponse
		? [...msgs].reverse().find((message) => message.role === 'user')
		: undefined;
	const canShowMessageTimestamps = phase === 'idle';

	// 首个内容块（文本或工具调用）到达后立即撤掉占位。请求失败不会产生
	// 内容，因此只在已经确实进入 streaming 后再由 idle 清理本地状态。
	useEffect(() => {
		if (!waitingForFirstResponse) return;
		if (hasFirstAssistantContent || (observedStreaming && phase === 'idle')) {
			setWaitingForFirstResponse(false);
			setObservedStreaming(false);
			return;
		}
		if (phase === 'streaming') setObservedStreaming(true);
	}, [hasFirstAssistantContent, observedStreaming, phase, waitingForFirstResponse]);

	// A spinner that appears and vanishes inside a couple of frames reads
	// as a flicker, not as feedback — so hold it back until the load has
	// gone on long enough to be worth reporting. The gap renders blank,
	// which is invisible at this duration.
	const [showSpinner, setShowSpinner] = useState(false);
	useEffect(() => {
		if (!loading) {
			setShowSpinner(false);
			return;
		}
		const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
		return () => clearTimeout(timer);
	}, [loading]);

	const toConfirmedToolCalls = useMemo(() => {
		if (msgs.length === 0) return [];

		const lastMsg = msgs[msgs.length - 1];
		return getContentBlocks(lastMsg, 'tool_call')
			.filter((tc) => tc.state === 'asking')
			.map((tc) => ({ replyId: lastMsg.id, toolCall: tc }));
	}, [msgs]);

	// On an empty session the prompt and the input centre together, so every box
	// down to the message list shrinks to its content instead of filling.
	return (
		<div
			className={cn(
				'flex flex-col h-full w-full items-center gap-4',
				isEmpty && 'justify-center',
				className,
			)}
		>
			{loading ? (
				<div className="flex flex-1 w-full items-center justify-center">
					{showSpinner ? <Spinner className="size-5 text-muted-foreground" /> : null}
				</div>
			) : isEmpty ? (
				// 空态标题保持纯文字。Electron 对文字背景裁剪的兼容渲染曾将
				// 渐变标题错误绘制成整块白色矩形，因此不再依赖 background-clip。
				<div className="relative flex flex-col items-center gap-3 px-8 text-center">
              <h1 className="relative animate-fade-up font-sans text-5xl font-normal leading-tight tracking-[-0.045em] text-foreground">
						{projectName
							? t('chat.greetingProject', { project: projectName })
							: t('chat.greeting')}
					</h1>
				</div>
			) : (
				<MessageScrollerProvider autoScroll={true} defaultScrollPosition={'end'}>
					<MessageScroller>
						<MessageScrollerViewport>
							<MessageScrollerContent className="pt-6 pb-2">
								{msgs.map((message, index) => {
									const previous = msgs[index - 1];
									const at = new Date(message.created_at);
									const previousAt = previous
										? new Date(previous.finished_at ?? previous.created_at)
										: at;
									return (
										<MessageScrollerItem
											key={message.id}
											messageId={message.id}
										>
											{at.getTime() - previousAt.getTime() >
												TIME_MARKER_GAP_MS && (
												<Marker
													variant="separator"
													className="mb-6 font-mono text-xs"
												>
													<MarkerContent>
														{markerStamp(at, previousAt, i18n.language)}
													</MarkerContent>
												</Marker>
											)}
										<ASMessageBubble
											message={message}
											skillLibrary={library.skills}
											onUserConfirm={onUserConfirm}
											showThinking={message === waitingUserMessage}
											showTimestamp={canShowMessageTimestamps}
										/>
									</MessageScrollerItem>
									);
								})}
								{msgs.length > 0 &&
									msgs[msgs.length - 1].finished_reason ===
										ReplyFinishedReason.EXCEED_MAX_ITERS &&
									phase === 'idle' && (
										<Alert
											variant={'default'}
											className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-50"
										>
											<TriangleAlert />
											<AlertTitle>
												{t('chat.maxItersExceeded.title')}
											</AlertTitle>
											<AlertDescription>
												{t('chat.maxItersExceeded.description')}
											</AlertDescription>
											<AlertAction>
												<Button
													size={'xs'}
													onClick={() => {
														onSend([
															{
																id: crypto.randomUUID(),
																type: 'text',
																text: t(
																	'chat.maxItersExceeded.continue',
																),
																created_at:
																	new Date().toISOString(),
																finished_at:
																	new Date().toISOString(),
															} as TextBlock,
														]);
													}}
												>
													{t('chat.maxItersExceeded.continue')}
												</Button>
											</AlertAction>
										</Alert>
									)}
							</MessageScrollerContent>
						</MessageScrollerViewport>
						<MessageScrollerButton className="rounded-rect" />
					</MessageScroller>
				</MessageScrollerProvider>
			)}

			{/* 输入区不随 loading 卸载：会话切换/恢复的加载窗口里，整块卸载会
			    连带拆掉 WorkspacePicker 与模型选择器——打开一半的弹层被销毁、
			    点击全部落空，用户视角就是"选不了文件夹、选不了模型、点不动"。
			    loading 只影响上方消息区（spinner 有 SPINNER_DELAY_MS 延迟，
			    短窗几乎无感），输入区始终可用。 */}
			<div className="relative min-w-full max-w-full w-full pb-4">
					<FlipCard
						visible={toConfirmedToolCalls.length > 0 || footerSlot !== null}
						className="absolute bottom-full left-0 right-0 mb-2 z-50"
					>
						{toConfirmedToolCalls.length > 0 ? (
							<ConfirmCard
								key={`${toConfirmedToolCalls[0].replyId}:${toConfirmedToolCalls[0].toolCall.id}`}
								toolCall={toConfirmedToolCalls[0].toolCall}
								onUserConfirm={(confirm, rules) =>
									onUserConfirm(
										toConfirmedToolCalls[0].toolCall,
										confirm,
										toConfirmedToolCalls[0].replyId,
										rules,
									)
								}
							/>
						) : (
							footerSlot
						)}
					</FlipCard>
					{/* 输入区直接坐在画布上：WorkspacePicker 行无底无框，
				    白色胶囊是唯一的表面。曾经包在外面的 bg-muted 圆角壳
				    会形成「框中框」（深色下是亮框，浅色下也有包裹感），
				    已拆除。 */}
					<TextInput
						className="min-w-full max-w-full w-full"
						onSend={handleSend}
						commandItems={slashItems}
						disabled={disabled}
						autoComplete={autoComplete}
						allowedInputTypes={allowedInputTypes}
						fileProcessor={fileProcessor}
						phase={phase}
						onInterrupt={onInterrupt}
						headerSlot={
							<div className="flex w-full flex-col gap-1">
								<div className="flex w-full items-center justify-between gap-2 px-2 py-1 text-sm text-muted-foreground">
									<WorkspacePicker
										value={cwd}
										onChange={onCwdChange}
									/>
								<div className="flex min-w-0 items-center gap-x-2">
									{inputControls}
								{git && (
									<Button
										className="font-mono"
										variant="secondary"
										size="sm"
										onClick={() => void onRefreshGit?.()}
										title={t('workdir.gitTooltip', {
											staged: git.staged,
											unstaged: git.unstaged,
											untracked: git.untracked,
										})}
									>
										<GitBranch />
										{/* A detached HEAD has no branch to name, so
										    fall back to the commit it sits on. The
										    server sends no git at all when it has
										    neither. */}
										{git.branch ?? git.head?.slice(0, 7)}
										{git.ahead !== null && git.ahead > 0 && (
											<span className="text-xs">↑{git.ahead}</span>
										)}
										{git.behind !== null && git.behind > 0 && (
											<span className="text-xs">↓{git.behind}</span>
										)}
										{/* Renders nothing when both are zero, so a
										    clean tree shows just the branch. */}
										<DiffStats
											className="text-xs font-mono"
											insertions={git.insertions}
											deletions={git.deletions}
										/>
									</Button>
								)}
								</div>
								</div>
							</div>
						}
					/>
				</div>
		</div>
	);
};

export const ChatContent = React.memo(ChatContentComponent);
