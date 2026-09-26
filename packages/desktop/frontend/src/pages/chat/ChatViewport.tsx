import type { PermissionContext } from '@agentscope-ai/agentscope/permission';
import type { TaskContext } from '@agentscope-ai/agentscope/state';
import {
	BookText,
	ChevronDown,
	Database,
	GitCompare,
	Globe,
	History,
	ListTodo,
	PanelRight,
	Webhook,
	ShieldCheck,
	SquareTerminal,
	UsersRound,
} from 'lucide-react';
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import type {
	ChatModelConfig,
	PermissionMode,
	SessionKnowledgeConfig,
	UpdateSessionRequest,
} from '@/api';
import { sessionApi, skillApi } from '@/api';
import MCPSvg from '@/assets/images/mcp.svg?react';
import { ChatContent } from '@/components/chat/ChatContent.tsx';
import { QuestionPanel } from '@/components/chat/QuestionPanel';
import { SubagentHitlCard } from '@/components/chat/SubagentHitlCard';
import { PanelDock, type PanelDescriptor, type PanelKey } from '@/components/panel/PanelDock.tsx';
import { KnowledgeBaseParametersPopover } from '@/components/popover/KnowledgeBaseParametersPopover';
import { LlmSelect } from '@/components/select/LlmSelect';
import { PermissionModeSelect } from '@/components/select/PermissionModeSelect.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from '@/components/ui/resizable.tsx';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useAvailableModels } from '@/hooks/useAvailableModels';
import { useCocodeData } from '@/hooks/useCocodeData';
import { useKnowledgeBaseMiddlewareSchema } from '@/hooks/useKnowledgeBaseMiddlewareSchema';
import { useKnowledgeBases } from '@/hooks/useKnowledgeBases';
import { useMessages } from '@/hooks/useMessages';
import { useSessions } from '@/hooks/useSessions';
import { useWorkspace } from '@/hooks/useWorkspace.ts';
import { useWorkspaceStatus } from '@/hooks/useWorkspaceStatus';
import { useTranslation } from '@/i18n/useI18n';
import { OPEN_PANEL_EVENT } from '@/lib/openPanel';
import { openSettings } from '@/lib/openSettings';
import { getProjectDisplayName, PROJECT_NAMES_CHANGED_EVENT } from '@/lib/projectNaming';

// 侧栏内容不属于首屏；只在用户真正打开时下载和解析对应模块。
const BrowserPanel = lazy(async () => ({ default: (await import('@/components/panel/BrowserPanel')).BrowserPanel }));
const CheckpointPanel = lazy(async () => ({ default: (await import('@/components/panel/CheckpointPanel')).CheckpointPanel }));
const DiffPanel = lazy(async () => ({ default: (await import('@/components/panel/DiffPanel')).DiffPanel }));
const KnowledgeBasePanel = lazy(async () => ({ default: (await import('@/components/panel/KnowledgeBasePanel')).KnowledgeBasePanel }));
const McpPanel = lazy(async () => ({ default: (await import('@/components/panel/McpPanel')).McpPanel }));
const PermissionPanel = lazy(async () => ({ default: (await import('@/components/panel/PermissionPanel')).PermissionPanel }));
const SkillPanel = lazy(async () => ({ default: (await import('@/components/panel/SkillPanel')).SkillPanel }));
const TaskPanel = lazy(async () => ({ default: (await import('@/components/panel/TaskPanel')).TaskPanel }));
const TeamPanel = lazy(async () => ({ default: (await import('@/components/panel/TeamPanel')).TeamPanel }));
const TerminalPanel = lazy(async () => ({ default: (await import('@/components/panel/TerminalPanel')).TerminalPanel }));
const HooksPanel = lazy(async () => ({ default: (await import('@/components/panel/HooksPanel')).HooksPanel }));

interface ChatViewportProps {
	/**
	 * The agent that owns the session being viewed. May be the
	 * user-facing leader agent or — when drilled into a team member
	 * via the URL's `:memberId` slot — a worker agent.
	 */
	agentId: string | null;
	/**
	 * The session whose messages, model config, permission mode, and
	 * workspace drive every control rendered here. May be ``null`` when
	 * the chat was opened without a session; sending the first message
	 * will auto-create one and call ``onSessionCreated``.
	 */
	sessionId: string | null;
	/**
	 * Optional hook invoked when a server-side change to this session
	 * or its team arrives on the SSE stream. The outer page owns the
	 * session list that backs the sidebar, so it must be told to
	 * refetch too; passing this callback wires that signal up.
	 */
	onSessionsChanged?: () => void;
	/**
	 * Called when the user sends into a session that didn't exist yet
	 * and a brand-new one was created on the server. The outer page is
	 * expected to navigate the URL to point at the new id so a page
	 * reload lands the user back in the conversation they just started.
	 */
	onSessionCreated?: (sessionId: string) => void;
}

/** Maximum number of panels stacked in a single dock column. */
const MAX_PANELS_PER_COLUMN = 2;

/** localStorage key holding the dock layout across page navigations. */
const PANEL_LAYOUT_KEY = 'chat_panel_layout';

// Typed as a full Record so adding a PanelKey without listing it here
// is a compile error rather than a silently unrestorable panel.
const KNOWN_PANELS: Record<PanelKey, true> = {
	plan: true,
	mcp: true,
	skill: true,
	permission: true,
	knowledge: true,
	team: true,
	checkpoint: true,
	diff: true,
	hooks: true,
	browser: true,
	terminal: true,
};

/**
 * Restore the persisted dock layout, dropping anything that is no
 * longer a known panel (keys get renamed/removed across releases).
 *
 * @returns The stored layout, or an empty one when absent or corrupt.
 */
function loadPanelLayout(): PanelKey[][] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) ?? '[]');
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((column: unknown) =>
				Array.isArray(column)
					? column.filter((key): key is PanelKey => key in KNOWN_PANELS)
					: [],
			)
			.filter((column) => column.length > 0);
	} catch {
		return [];
	}
}

/**
 * Insert a panel into the dock layout. Scans columns left to right and
 * appends to the first one with spare room; if every column is full a
 * new rightmost column is created. No-op when the panel is already
 * open.
 *
 * @param layout - The current column/panel arrangement.
 * @param key - The panel to open.
 * @returns A new layout array (the input is never mutated).
 */
function openPanelInLayout(layout: PanelKey[][], key: PanelKey): PanelKey[][] {
	if (layout.some((column) => column.includes(key))) return layout;
	const targetIndex = layout.findIndex((column) => column.length < MAX_PANELS_PER_COLUMN);
	if (targetIndex === -1) return [...layout, [key]];
	return layout.map((column, index) => (index === targetIndex ? [...column, key] : column));
}

/**
 * Remove a panel from the dock layout, dropping its column entirely if
 * it becomes empty.
 *
 * @param layout - The current column/panel arrangement.
 * @param key - The panel to close.
 * @returns A new layout array (the input is never mutated).
 */
function closePanelInLayout(layout: PanelKey[][], key: PanelKey): PanelKey[][] {
	return layout
		.map((column) => column.filter((panelKey) => panelKey !== key))
		.filter((column) => column.length > 0);
}

/**
 * The right-hand main panel of the chat page — every UI element that
 * operates on a single `(agentId, sessionId)` pair lives here:
 * model selector, permission mode select, message stream, workspace
 * drawer, and the team sidebar.
 *
 * Self-contained by design. The outer page passes in the
 * `(agentId, sessionId)` it wants displayed (which may be the leader
 * session or a focused team member's session) and this component
 * does the rest — fetching the session view, syncing local UI state
 * with it, and writing changes back to the same session. Switching
 * between leader and member is just a prop change; no internal
 * branching is needed.
 *
 * @param agentId - The agent to operate on. `null` while no agent is
 *   selected yet (renders an empty / disabled state).
 * @param sessionId - The session to operate on. `null` while no
 *   session is selected yet.
 * @returns The right-side main JSX of the chat page.
 */
export function ChatViewport({ agentId, sessionId, onSessionsChanged, onSessionCreated }: ChatViewportProps) {
	const { t } = useTranslation();
	const { sessions, refetch: refetchSessions } = useSessions(agentId);
	const { groups } = useAvailableModels();

	// 还没有会话时，模型/工作目录/权限模式先记在这里；第一条消息发送、
	// 会话被自动创建时经 newSessionExtras 一起带过去 —— 否则三个控件在
	// 空状态下要么禁用、要么选了被静默丢掉。
	const [selectedModel, setSelectedModel] = useState<ChatModelConfig | null>(null);
	const [selectedKnowledgeConfig, setSelectedKnowledgeConfig] =
		useState<SessionKnowledgeConfig | null>(null);
	const [selectedPermissionMode, setSelectedPermissionMode] = useState<string>('default');
	const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
	const [projectNamesVersion, setProjectNamesVersion] = useState(0);
	const [credentialRefetchTrigger] = useState(0);
	const [tasksContext, setTasksContext] = useState<TaskContext | null>(null);
	const [permissionContext, setPermissionContext] = useState<PermissionContext | null>(null);
	const [configPending, setConfigPending] = useState(false);
	// Dock layout: columns laid out left→right, each holding up to 2
	// panels stacked top→bottom. Open order determines placement.
	// Persisted so leaving and returning to /chat keeps the same panels.
	const [panelLayout, setPanelLayout] = useState<PanelKey[][]>(loadPanelLayout);
	const openPanels = useMemo(() => new Set(panelLayout.flat()), [panelLayout]);

	useEffect(() => {
		localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(panelLayout));
	}, [panelLayout]);

	// 项目改名发生在侧栏。自定义事件让当前空会话的欢迎语无需切换页面
	// 就能更新为新名称。
	useEffect(() => {
		const refreshProjectName = () => setProjectNamesVersion((version) => version + 1);
		window.addEventListener(PROJECT_NAMES_CHANGED_EVENT, refreshProjectName);
		return () => window.removeEventListener(PROJECT_NAMES_CHANGED_EVENT, refreshProjectName);
	}, []);

	// When the viewport agent differs from the outer page's selected
	// agent (i.e. user drilled into a team member), `refetchSessions`
	// only refreshes the member's session list, so we also fire the
	// parent's refetch to keep its copy in sync.
	//
	// Surfacing the team panel here is what makes a team visible at all
	// — `TeamCreate` / `AgentCreate` / `AgentInvite` are agent tools, so
	// the user never opened a dialog that could have opened the panel.
	// `team_updated` also fires on `TeamDelete` and carries no payload,
	// hence checking the refetched list rather than opening blindly.
	const handleTeamUpdated = useCallback(async () => {
		const next = await refetchSessions();
		if (next.some((v) => v.session.id === sessionId && v.team)) {
			// `openPanelInLayout`, not `togglePanel` — the latter would
			// close a panel the user already has open.
			setPanelLayout((layout) => openPanelInLayout(layout, 'team'));
		}
		onSessionsChanged?.();
	}, [refetchSessions, sessionId, onSessionsChanged]);

	// Auto-naming replaced the session's placeholder name. The outer
	// page shares this cached list whenever both are looking at the same
	// agent; when they are not — drilled into a team member — it needs
	// its own nudge.
	const handleSessionUpdated = useCallback(async () => {
		await refetchSessions();
		onSessionsChanged?.();
	}, [refetchSessions, onSessionsChanged]);

	// 上下文自动压缩提示：后端在超出 token 预算并驱逐/摘要后广播
	// context_compacted。用一个非阻塞 toast 告知用户"较早历史已被压缩"，
	// 避免他以为信息凭空消失。连续多次压缩用同一 id 覆盖，不刷屏。
	const handleContextCompacted = useCallback(
		(info: {
			evicted: number;
			compacted: boolean;
			tokensBefore: number;
			tokensAfter: number;
			budget: number;
		}) => {
			const parts: string[] = [];
			if (info.evicted > 0)
				parts.push(t('chat.context.compact.evicted', { count: info.evicted }));
			if (info.compacted) parts.push(t('chat.context.compact.compacted'));
			toast.info(t('chat.context.compact.title'), {
				id: `ctx-compact-${sessionId ?? 'anon'}`,
				description: t('chat.context.compact.description', {
					parts: parts.join('，') || t('chat.context.compact.fallback'),
					before: info.tokensBefore,
					after: info.tokensAfter,
					budget: info.budget,
				}),
				duration: 6000,
			});
		},
		[sessionId, t],
	);

	// Surface the plan panel the first time a session's tasks arrive over
	// the stream, and only then — reopening it on every update would undo
	// the user closing it. `state_updated` also fires for permission-only
	// changes and always carries `tasks_context`, hence gating on a
	// non-empty task list rather than the field being present.
	const taskPanelOpenedForRef = useRef<string | null>(null);
	const handleStateUpdated = useCallback(
		(value: Record<string, unknown>) => {
			if (value.tasks_context) {
				const incoming = value.tasks_context as TaskContext;
				setTasksContext(incoming);
				if (incoming.tasks.length > 0 && taskPanelOpenedForRef.current !== sessionId) {
					taskPanelOpenedForRef.current = sessionId;
					setPanelLayout((layout) => openPanelInLayout(layout, 'plan'));
				}
			}
			if (value.permission_context) {
				setPermissionContext(value.permission_context as PermissionContext);
			}
		},
		[sessionId],
	);

	const {
		msgs,
		loading: messagesLoading,
		phase,
		send,
		onUserConfirm,
		onSubagentConfirm,
		subagentHitl,
		userQuestion,
		answerQuestion,
		interrupt,
		reloadHistory,
	} = useMessages(agentId, sessionId, {
		onTeamUpdated: handleTeamUpdated,
		onStateUpdated: handleStateUpdated,
		onSessionUpdated: handleSessionUpdated,
		onContextCompacted: handleContextCompacted,
		onSessionCreated,
		// A model picked before the session exists lives only in
		// `selectedModel` — hand it to the session auto-created on the
		// first send, so the pick survives into the conversation.
		// 工作目录与权限模式同理：无会话时先记本地，建会话时一并带上。
		newSessionExtras: () => ({
			...(selectedModel ? { chat_model_config: selectedModel } : {}),
			...(selectedCwd ? { cwd: selectedCwd } : {}),
			...(selectedPermissionMode !== 'default' ? { permission_mode: selectedPermissionMode } : {}),
		}),
	});
	const {
		mcps,
		loading: mcpsLoading,
		addMcps,
		addMcpsFromLibrary,
		removeMcp,
		skills,
		skillsLoading,
		uploadSkill,
		addSkillsFromLibrary,
		removeSkill,
	} = useWorkspace(agentId, sessionId, { loadMcp: openPanels.has('mcp') });
	const { knowledgeBases, loading: knowledgeBasesLoading } = useKnowledgeBases();
	const { schema: kbMiddlewareSchema } = useKnowledgeBaseMiddlewareSchema(
		openPanels.has('knowledge'),
	);

	// 外部要求打开面板：目前是 Agent 的 Browser 工具（桌面端主进程派发事件）。
	// 用 openPanelInLayout 而不是 togglePanel —— 已经打开时不能再点一下把它关掉。
	useEffect(() => {
		const handler = (e: Event) => {
			const key = (e as CustomEvent<PanelKey>).detail;
			if (!key || !(key in KNOWN_PANELS)) return;
			setPanelLayout((layout) => openPanelInLayout(layout, key));
		};
		window.addEventListener(OPEN_PANEL_EVENT, handler);
		return () => window.removeEventListener(OPEN_PANEL_EVENT, handler);
	}, []);

	// Toggle a panel open/closed from the top-bar buttons.
	const togglePanel = useCallback((key: PanelKey) => {
		setPanelLayout((layout) =>
			layout.some((column) => column.includes(key))
				? closePanelInLayout(layout, key)
				: openPanelInLayout(layout, key),
		);
	}, []);

	// Close a panel (driven by the panel's own close button).
	const closePanel = useCallback((key: PanelKey) => {
		setPanelLayout((layout) => closePanelInLayout(layout, key));
	}, []);

	const isPanelOpen = useCallback((key: PanelKey) => openPanels.has(key), [openPanels]);

	// 本地导入技能：原生文件夹对话框选目录 → 后端按路径收进技能库 →
	// 有会话时顺手装进当前工作区。纯浏览器环境（无壳层桥）由对话框侧隐藏入口。
	const handleImportLocal = useCallback(async () => {
		const bridge = (window as unknown as {
			cocodeWindow?: { openFolderDialog: () => Promise<string | null> };
		}).cocodeWindow;
		if (!bridge?.openFolderDialog) {
			throw new Error('本地导入需要桌面端 App（原生文件夹对话框）');
		}
		const dir = await bridge.openFolderDialog();
		if (!dir) return; // 用户取消
		const { skill } = await skillApi.importLocal(dir);
		if (agentId && sessionId) {
			await addSkillsFromLibrary([skill.id]);
		}
	}, [agentId, sessionId, addSkillsFromLibrary]);

	/**
	 * Persist a knowledge-base attachment change. `null` detaches every
	 * knowledge base from this session, removing the `RAGMiddleware`.
	 *
	 * Declared above `panels` (rather than alongside the other model
	 * handlers below) because `panels` is built inside `useMemo` and
	 * references this handler eagerly — a later `const` would still be
	 * in the temporal dead zone when the memo factory runs on first
	 * render.
	 *
	 * @param config - New attachment, or `null` to detach all.
	 */
	/**
	 * Persist a session config change, applying it locally only once
	 * the server accepts it.
	 *
	 * The backend rejects config writes with 409 while a chat run holds
	 * the session, so an optimistic update would leave the control
	 * showing a value the session does not have. Waiting for the
	 * response keeps the control on its previous value with no rollback
	 * bookkeeping; `client.ts` has already surfaced the error toast by
	 * the time we land in `catch`.
	 *
	 * Declared above `panels` for the same temporal-dead-zone reason as
	 * `handleKnowledgeConfigChange` below.
	 *
	 * @param body - The PATCH body.
	 * @param apply - Mirrors the change into local state on success.
	 */
	const patchConfig = useCallback(
		async (body: UpdateSessionRequest, apply: () => void) => {
			if (!sessionId || !agentId) return;
			setConfigPending(true);
			try {
				await sessionApi.update(sessionId, agentId, body);
				apply();
				// refetch 不 await：PATCH 已确认成功，`apply()` 让控件即时反馈；
				// 再串行等一次列表往返，选择器要空白多一个来回才解除置灰——
				// 慢网络下就是"点了模型没反应、下拉一直灰着"。后台补数据即可。
				void refetchSessions();
			} catch {
				// Toast already shown; local state deliberately untouched.
			} finally {
				setConfigPending(false);
			}
		},
		[sessionId, agentId, refetchSessions],
	);

	const handleKnowledgeConfigChange = useCallback(
		async (config: SessionKnowledgeConfig | null) => {
			await patchConfig({ knowledge_config: config }, () =>
				setSelectedKnowledgeConfig(config),
			);
		},
		[patchConfig],
	);

	// Declared above `panels` — the memo factory reads `view.team`
	// eagerly on first render, so a later `const` would still be in
	// the temporal dead zone.
	const view = sessions.find((v) => v.session.id === sessionId) ?? null;
	const activeCwd = view?.session.config.cwd ?? selectedCwd ?? null;
	const activeProjectName = useMemo(
		() => getProjectDisplayName(activeCwd),
		[activeCwd, projectNamesVersion],
	);

	const { status: workspaceStatus, refetch: refetchWorkspaceStatus } = useWorkspaceStatus(
		agentId,
		sessionId,
		activeCwd,
	);

	// A finished reply is the one moment the agent may have changed the
	// working tree, and it is why nothing polls for git status. Watching
	// `phase` rather than the REPLY_END event also covers the interrupt
	// timeout, which reaches idle without one.
	const prevPhaseRef = useRef(phase);
	// Checkpoints / diff / hooks move for the same reason git status
	// does: a reply just finished. One trigger drives all of them.
	const cocode = useCocodeData(agentId, sessionId, activeCwd, {
		checkpoints: openPanels.has('checkpoint'),
		diff: openPanels.has('diff'),
		hooks: openPanels.has('hooks'),
	});
	const { refresh: refreshCocode } = cocode;
	useEffect(() => {
		const wasRunning = prevPhaseRef.current !== 'idle';
		prevPhaseRef.current = phase;
		if (wasRunning && phase === 'idle') {
			void refetchWorkspaceStatus();
			void refreshCocode();
		}
	}, [phase, refetchWorkspaceStatus, refreshCocode]);

	// Build the panel descriptors with live data. Rebuilt on every
	// data change so the dock always renders the latest state — the
	// dock itself stays free of any data dependency.
	const panels = useMemo<Record<PanelKey, PanelDescriptor>>(
		() => ({
			plan: {
				title: t('panel.plan.title'),
				icon: <ListTodo className="size-4" />,
				content: <TaskPanel tasksContext={tasksContext} />,
			},
			mcp: {
				title: 'MCP',
				icon: <MCPSvg className="size-4" />,
				content: (
					<McpPanel
						mcps={mcps}
						loading={mcpsLoading}
						onAdd={addMcps}
						onAddFromLibrary={addMcpsFromLibrary}
						onRemove={removeMcp}
					/>
				),
			},
			skill: {
				title: t('panel.skill.title'),
				icon: <BookText className="size-4" />,
				content: (
					<SkillPanel
						skills={skills}
						loading={skillsLoading}
						onUpload={uploadSkill}
						onAddFromLibrary={addSkillsFromLibrary}
						onImportLocal={handleImportLocal}
						onRemove={removeSkill}
					/>
				),
			},
			permission: {
				title: (
					<span className="flex items-center gap-x-2">
						{t('panel.permission.title')}
						{permissionContext?.mode ? (
							<Badge variant="outline" className="capitalize">
								{t('panel.permission.mode', { mode: permissionContext.mode })}
							</Badge>
						) : null}
					</span>
				),
				icon: <ShieldCheck className="size-4" />,
				content: <PermissionPanel permissionContext={permissionContext} />,
			},
			knowledge: {
				title: (
					<span className="flex items-center gap-x-2">
						{t('panel.knowledge.title')}
						{selectedKnowledgeConfig?.knowledge_base_ids.length ? (
							<Badge variant="outline">
								{selectedKnowledgeConfig.knowledge_base_ids.length}
							</Badge>
						) : null}
					</span>
				),
				icon: <Database className="size-4" />,
				actions: (
					<KnowledgeBaseParametersPopover
						value={selectedKnowledgeConfig}
						schema={kbMiddlewareSchema}
						onChange={handleKnowledgeConfigChange}
						disabled={!sessionId}
					/>
				),
				content: (
					<KnowledgeBasePanel
						knowledgeBases={knowledgeBases}
						loading={knowledgeBasesLoading}
						value={selectedKnowledgeConfig}
						onChange={handleKnowledgeConfigChange}
						disabled={!sessionId}
					/>
				),
			},
			team: {
				title: (
					<span className="flex items-center gap-x-2">
						{t('common.team')}
						{view?.team ? (
							<Badge variant="outline">{view.team.members.length}</Badge>
						) : null}
					</span>
				),
				icon: <UsersRound className="size-4" />,
				content: <TeamPanel team={view?.team ?? null} currentSessionId={sessionId} />,
			},
			// ── CoCode 独有：检查点 / 变更预览 ──
			checkpoint: {
				title: (
					<span className="flex items-center gap-x-2">
						{t('panel.workspace.checkpoint')}
						{cocode.checkpoints.length ? (
							<Badge variant="outline">{cocode.checkpoints.length}</Badge>
						) : null}
					</span>
				),
				icon: <History className="size-4" />,
				content: (
					<CheckpointPanel
						checkpoints={cocode.checkpoints}
						loading={cocode.loading}
						onRestore={cocode.restoreCheckpoint}
						onRefresh={cocode.refresh}
					/>
				),
			},
			diff: {
				title: t('panel.workspace.diff'),
				icon: <GitCompare className="size-4" />,
				content: (
					<DiffPanel
						diff={cocode.diff}
						error={cocode.diffError}
						errorCode={cocode.diffErrorCode}
						loading={cocode.loading}
						onRefresh={cocode.refresh}
						root={workspaceStatus?.cwd ?? view?.session.config.cwd ?? null}
					/>
				),
			},
			browser: {
				title: t('panel.workspace.browser'),
				icon: <Globe className="size-4" />,
				content: <BrowserPanel />,
			},
			terminal: {
				title: t('panel.workspace.terminal'),
				icon: <SquareTerminal className="size-4" />,
				content: (
					<TerminalPanel
						cwd={activeCwd}
					/>
				),
			},
			hooks: {
				title: t('panel.workspace.hooks'),
				icon: <Webhook className="size-4" />,
				content: (
					<HooksPanel
						hooks={cocode.hooks}
						loading={cocode.loading}
						onRefresh={cocode.refresh}
						onTrustProjectHooks={(trust) => {
							const target = workspaceStatus?.cwd ?? view?.session.config.cwd;
							if (target) void cocode.setProjectHooksTrusted(target, trust);
						}}
					/>
				),
			},
		}),
		[
			t,
			tasksContext,
			mcps,
			mcpsLoading,
			addMcps,
			addMcpsFromLibrary,
			removeMcp,
			skills,
			skillsLoading,
			uploadSkill,
			addSkillsFromLibrary,
			removeSkill,
			permissionContext,
			knowledgeBases,
			knowledgeBasesLoading,
			selectedKnowledgeConfig,
			kbMiddlewareSchema,
			handleKnowledgeConfigChange,
			sessionId,
			view,
			cocode,
			workspaceStatus?.cwd,
			activeCwd,
		],
	);

	// Safety net for a `view` that never arrives. A session created from
	// the outer page reaches this list on its own, since both mount the
	// same cached query — but not when the two are looking at different
	// agents (drilled into a team member), and not for a write that
	// happened outside either. Without a `view` every effect below
	// early-returns on `!view`, leaving the model select and friends
	// pinned to whatever the previously-viewed session had configured.
	useEffect(() => {
		if (!sessionId) return;
		if (view) return;
		refetchSessions();
	}, [sessionId, view, refetchSessions]);

	// Reset local UI state when the target session changes. Otherwise
	// the model select (and disabled-state guards on `send`) would
	// show the previous session's model during the in-flight window
	// before `view` repopulates — and an immediate send would post to
	// a session whose backend config doesn't actually have that model.
	// 无会话期间暂存的 cwd 也一并清：切换目标会话后旧暂存不再有意义。
	//
	// 但「空态 → 它自己刚建的会话」这次翻转不清：暂存的模型/目录/权限
	// 正是建会话时随 newSessionExtras 带过去的值，抹掉只会让选择器在
	// view 回填前闪成空白——用户看到的就是"发完第一条消息，模型和
	// 文件夹突然选不了了"。初始值 undefined 与两态无关，挂载仍照清。
	const prevSessionIdRef = useRef<string | null | undefined>(undefined);
	useEffect(() => {
		const prev = prevSessionIdRef.current;
		prevSessionIdRef.current = sessionId;
		if (prev === null && sessionId !== null) return;
		setSelectedModel(null);
		setSelectedKnowledgeConfig(null);
		setSelectedCwd(null);
	}, [sessionId]);

	const selectedModelCard = useMemo(() => {
		if (!selectedModel) return null;
		const items = groups[selectedModel.type];
		if (!items) return null;
		for (const { models } of items) {
			const card = models.find((m) => m.name === selectedModel.model);
			if (card) return card;
		}
		return null;
	}, [groups, selectedModel?.type, selectedModel?.model]);

	/**
	 * Pick the first model the available-models endpoint surfaces, used
	 * as a sensible default when the current session has no model
	 * configured yet.
	 *
	 * @returns The first available `ChatModelConfig`, or `null` when
	 *   no credentials / models are configured.
	 */
	const getFirstAvailableModel = (): ChatModelConfig | null => {
		const firstType = Object.keys(groups)[0];
		if (!firstType) return null;
		const items = groups[firstType];
		if (!items || items.length === 0) return null;
		const firstItem = items[0];
		const firstModel = (firstItem.models as { name?: string; id?: string }[])[0];
		if (!firstModel) return null;
		const modelName = firstModel.name ?? firstModel.id ?? null;
		if (!modelName) return null;
		return {
			type: firstType,
			credential_id: firstItem.credential.id,
			model: modelName,
			parameters: {},
		};
	};

	// Seed tasks + permission from the session snapshot ONCE per
	// session, then leave them to the CustomEvent(name="state_updated")
	// stream via `handleStateUpdated`.
	//
	// Seeding on every `view` change would be wrong: storage is only
	// written when a run ends, so mid-run the snapshot still holds the
	// run-start values. `view` gets a new identity on every
	// `refetchSessions()` — which `team_updated` triggers — and
	// re-seeding then would silently roll both panels back to where the
	// reply started. Clearing on `!view` still matters so switching
	// sessions cannot leak the previous session's tasks or rules.
	const seededSessionRef = useRef<string | null>(null);
	useEffect(() => {
		if (!view) {
			seededSessionRef.current = null;
			setTasksContext(null);
			setPermissionContext(null);
			return;
		}
		if (seededSessionRef.current === view.session.id) return;
		seededSessionRef.current = view.session.id;
		const state = view.session.state as Record<string, unknown> | undefined;
		setTasksContext((state?.tasks_context as TaskContext) ?? null);
		// Prefer the full permission context (mode + rule sets +
		// working directories). Fall back to a minimal `{ mode }` shell
		// when only the flat legacy field is present, so the panel's
		// badge reflects what the dropdown shows for old sessions.
		const seededPermission =
			(state?.permission_context as PermissionContext | undefined) ??
			(state?.permission_mode
				? ({ mode: state.permission_mode } as PermissionContext)
				: null);
		setPermissionContext(seededPermission);
	}, [view]);

	// Sync selectedModel + selectedFallbackModel from the session
	// record. If the session has no model configured yet, auto-pick
	// the first available one and persist it back so subsequent
	// reasoning has a model to call.
	//
	// Important: skip while `view` is still loading. Otherwise the
	// in-flight window between "agentId changed" and "useSessions
	// returned the new list" looks like "session has no model" and
	// we would racily auto-select + persist the first available
	// model, clobbering whatever the user had configured.
	useEffect(() => {
		if (!view) return;
		const sessionModel = view.session.config.chat_model_config;

		if (sessionModel) {
			setSelectedModel(sessionModel);
		} else {
			const firstModel = getFirstAvailableModel();
			if (firstModel) {
				setSelectedModel(firstModel);
				if (sessionId && agentId) {
					// `silent` because the user did not ask for this write —
					// surfacing a toast for a revoked credential or a network
					// blip they never triggered is pure noise.
					sessionApi
						.update(
							sessionId,
							agentId,
							{ chat_model_config: firstModel },
							{ silent: true },
						)
						.then(() => refetchSessions())
						.catch(() => {});
				}
			} else {
				setSelectedModel(null);
			}
		}

		setSelectedKnowledgeConfig(view.session.config.knowledge_config ?? null);
	}, [view, groups, sessionId, agentId]);

	// Sync selectedPermissionMode when the session changes. Same
	// loading-window guard as above — don't reset the displayed mode
	// to "default" while the new session view is still on the wire.
	//
	// Two read paths on purpose: `permission_context.mode` is the
	// canonical field (also what `state_updated` pushes), while
	// `permission_mode` is a flat legacy field older sessions on disk
	// still carry. Reading both means a session created before the
	// context-object migration still shows its saved mode rather than
	// silently falling back to "default".
	useEffect(() => {
		if (!view) return;
		const state = view.session.state as Record<string, unknown> | undefined;
		const fromContext = (state?.permission_context as Record<string, unknown> | undefined)
			?.mode as string | undefined;
		const fromLegacy = state?.permission_mode as string | undefined;
		setSelectedPermissionMode(fromContext ?? fromLegacy ?? 'default');
	}, [sessionId, view]);

	/**
	 * Persist a model change to the session and refetch so the local
	 * view picks up the new value.
	 *
	 * A conversation that has no session yet (bare `/chat/:agent` — where
	 * the app lands on every launch, and what the first message is sent
	 * from) has nothing to PATCH. Bouncing the pick off `patchConfig` there
	 * would drop it on the floor: the button would not move and the first
	 * reply would still run on the default model. Keep it in local state
	 * instead and let `newSessionExtras` (below) hand it to the session
	 * `send` creates a moment later.
	 *
	 * @param config - New chat model config; `null` is ignored
	 *   because the primary selector does not allow clearing.
	 */
	const handleLlmChange = async (config: ChatModelConfig | null) => {
		if (!config) return;
		if (!sessionId || !agentId) {
			setSelectedModel(config);
			return;
		}
		await patchConfig({ chat_model_config: config }, () => setSelectedModel(config));
		// 模型切换提示条由后端写入 display，不经事件流——立即拉一次，
		// 让提示条即时出现在本地时间线（不等下轮消息或刷新页面）。
		await reloadHistory();
	};
	// 深度思考：默认开启（parameters.thinking 未设置也算开，显式 false 才关）。
	// thinkingEffort 为强度档 low/high/max（原 medium 并入 high），仅对
	// reasoning_effort 类端点生效（max 由 model.js 归一化为 high 发送）。
	// 强度调整入口在模型选择器详情卡（LlmSelect），经 handleLlmChange 持久化；
	// 无会话时仍先记本地，建会话随 chat_model_config 带上。

	/**
	 * Persist a permission-mode change.
	 *
	 * @param mode - New permission mode (e.g. `default`, `explore`).
	 */
	/**
	 * Persist a new working directory.
	 *
	 * Nothing local mirrors it — the value is read straight off the
	 * session view, which `patchConfig` refetches on success.
	 *
	 * @param next - Directory relative to the workspace root, or `null`
	 *   for the root itself.
	 */
	const handleCwdChange = async (next: string | null) => {
		// 还没有会话：先记在本地（输入框上方立即显示），建会话时带上
		if (!sessionId || !agentId) {
			setSelectedCwd(next);
			return;
		}
		// Bypasses `patchConfig`: the dialog shows the failure inline and
		// stays open on it, so the toast would be a duplicate and the
		// swallowed rejection would let the dialog close as if it worked.
		setConfigPending(true);
		try {
			await sessionApi.update(sessionId, agentId, { cwd: next }, { silent: true });
			await refetchSessions();
		} finally {
			setConfigPending(false);
		}
	};

	const handlePermissionModeChange = async (mode: string) => {
		// 还没有会话：先记在本地，建会话时带上（端点支持）
		if (!sessionId || !agentId) {
			setSelectedPermissionMode(mode);
			return;
		}
		await patchConfig({ permission_mode: mode as PermissionMode }, () =>
			setSelectedPermissionMode(mode),
		);
	};

	return (
		<>
			<main className="flex size-full">
				<ResizablePanelGroup orientation="horizontal">
					<ResizablePanel
						className="flex flex-1 min-h-0 min-w-0"
						minSize="24rem"
					>
						<div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-x-hidden bg-transparent">
						<div className="flex h-12 shrink-0 flex-row items-center justify-between border-b border-border px-5">
							<div className="flex min-w-0 flex-1 flex-row items-center gap-x-1">
									<SidebarTrigger className="md:hidden" />
									{/* The open session, named opposite its own
									    settings. The sidebar is the only other
									    place the name appears, and it collapses
									    on mobile — so on a narrow screen this is
									    the only thing saying which conversation
									    is on screen.

									    Withheld until the session has something
									    in it: an untouched one is still named
									    after the timestamp it was created at,
									    and a date is worse than no title at all.
									    The first reply replaces that with a real
									    one. */}
{msgs.length > 0 && (
									<span
										className="truncate px-2 text-sm text-muted-foreground"
										title={view?.session.config.name || t('chat.newConversation')}
									>
										{view?.session.config.name || t('chat.newConversation')}
									</span>
								)}
								{/* 窗口拖拽把手：只占标题右侧的空白，不覆盖任何可点元素。
								    整条顶栏设 app-drag 会把右边的面板开关按钮一起吞掉。 */}
								<div className="app-drag min-w-4 flex-1 self-stretch" />
								</div>
								{/* Never squeezed by a long session name: the
								    name truncates instead. */}
								{/* CoCode 定制：右栏仅保留 计划/技能 面板开关；MCP/权限/知识库/团队已隐藏 */}
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												className="gap-1 px-2"
											>
												<PanelRight />
												<ChevronDown className="size-3 text-muted-foreground" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end" className="w-auto">
											<DropdownMenuCheckboxItem
												checked={isPanelOpen('plan')}
												onCheckedChange={() => togglePanel('plan')}
												onSelect={(e) => e.preventDefault()}
											>
												<ListTodo />
												{t('panel.plan.title')}
											</DropdownMenuCheckboxItem>
										<DropdownMenuCheckboxItem
											checked={isPanelOpen('skill')}
											onCheckedChange={() => togglePanel('skill')}
											onSelect={(e) => e.preventDefault()}
										>
											<BookText />
											{t('panel.skill.title')}
										</DropdownMenuCheckboxItem>
										<DropdownMenuCheckboxItem
											checked={isPanelOpen('diff')}
											onCheckedChange={() => togglePanel('diff')}
											onSelect={(e) => e.preventDefault()}
										>
											<GitCompare />
												{t('panel.workspace.diff')}
										</DropdownMenuCheckboxItem>
										<DropdownMenuCheckboxItem
											checked={isPanelOpen('checkpoint')}
											onCheckedChange={() => togglePanel('checkpoint')}
											onSelect={(e) => e.preventDefault()}
										>
											<History />
											{t('panel.workspace.checkpoint')}
										</DropdownMenuCheckboxItem>
										<DropdownMenuCheckboxItem
											checked={isPanelOpen('hooks')}
											onCheckedChange={() => togglePanel('hooks')}
											onSelect={(e) => e.preventDefault()}
										>
											<Webhook />
											{t('panel.workspace.hooks')}
										</DropdownMenuCheckboxItem>
									<DropdownMenuCheckboxItem
										checked={isPanelOpen('browser')}
										onCheckedChange={() => togglePanel('browser')}
										onSelect={(e) => e.preventDefault()}
									>
										<Globe />
									{t('panel.workspace.browser')}
								</DropdownMenuCheckboxItem>
								<DropdownMenuCheckboxItem
									checked={isPanelOpen('terminal')}
									onCheckedChange={() => togglePanel('terminal')}
									onSelect={(e) => e.preventDefault()}
								>
									<SquareTerminal />
									{t('panel.workspace.terminal')}
								</DropdownMenuCheckboxItem>
								</DropdownMenuContent>
									</DropdownMenu>
							</div>
							<div className="canvas-glow flex flex-1 justify-center min-h-0 overflow-hidden relative [--chat-content-w:54rem]">
								<ChatContent
									className={'max-w-[var(--chat-content-w)] w-full'}
									msgs={msgs}
									loading={messagesLoading}
									// 无会话时显示本地暂存的目录（选完立即可见，建会话时带上）
									cwd={activeCwd}
									projectName={activeProjectName}
									onCwdChange={handleCwdChange}
									git={workspaceStatus?.git ?? null}
									workspaceSkills={skills}
									workspaceKnowledgeBases={knowledgeBases}
									userCommands={cocode.commands}
									modelControl={
										<LlmSelect
											id="tour-llm-select"
											composer
											value={selectedModel}
											onChange={handleLlmChange}
											onAddCredential={() => openSettings('model')}
											refetchTrigger={credentialRefetchTrigger}
											disabled={configPending}
										/>
									}
									permissionControl={
										<PermissionModeSelect
											id="tour-permission-mode"
											composer
											value={selectedPermissionMode}
											learnMore
											// 无会话也允许切换：先记本地，建会话时随第一条消息带上
											disabled={configPending}
											onChange={handlePermissionModeChange}
										/>
									}
									phase={phase}
								// 只在还没选 agent 时禁用输入框；sessionId 是否
								// 存在交给 useMessages.send() 内部自动创建
								//（R3 行为），避免"没有会话就输不进字"。
								// 模型是否可用由 TextInput 内部的 send 按钮
								// 单独判定（无模型时禁发，不锁 textarea）。
								disabled={!agentId}
									onSend={send}
									onUserConfirm={onUserConfirm}
									onInterrupt={interrupt}
									// cwd={
									// 	{cwd: view?.session.config.cwd, git: {
									// 		branch: 'main',
									// 		deletion: 0,
									// 		addition: 0,
									// 	}}
									// }
									footerSlot={
										userQuestion ? (
											<QuestionPanel
												key={userQuestion.ask_id}
												entry={userQuestion}
												onSubmit={(answers, note) =>
													answerQuestion(userQuestion, { answers, note })
												}
												onCancel={() =>
													answerQuestion(userQuestion, {
														answers: [],
														cancelled: true,
													})
												}
											/>
										) : subagentHitl.length > 0 ? (
											<SubagentHitlCard
												key={`${subagentHitl[0].worker_session_id}:${subagentHitl[0].reply_id}`}
												entry={subagentHitl[0]}
												onConfirm={(toolCall, confirm, rules) =>
													onSubagentConfirm(
														subagentHitl[0],
														toolCall,
														confirm,
														rules,
													)
												}
											/>
										) : null
									}
									allowedInputTypes={(
										selectedModelCard?.input_types ?? []
									).filter(
										(t) =>
											/^(image|video|audio|text)\/.+/.test(t) ||
											t === 'application/pdf' ||
											t.startsWith('application/vnd.') ||
											t.startsWith('application/msword') ||
											t.startsWith('application/vnd.openxmlformats'),
									)}
									fileProcessor={async (file) => {
										const filePath = (file as File & { path?: string }).path;
										if (filePath) {
											return {
												id: crypto.randomUUID(),
												type: 'data' as const,
												source: {
													type: 'url' as const,
													url: `file://${filePath}`,
													media_type:
														file.type || 'application/octet-stream',
												},
												name: file.name,
												created_at: new Date().toISOString(),
											};
										}
										if (file.type === 'text/plain') {
											const text = await file.text();
											return {
												id: crypto.randomUUID(),
												type: 'text' as const,
												text: `[File: ${file.name}]\n${text}`,
												created_at: new Date().toISOString(),
											};
										}
										const buffer = await file.arrayBuffer();
										const bytes = new Uint8Array(buffer);
										let binary = '';
										for (let i = 0; i < bytes.byteLength; i++) {
											binary += String.fromCharCode(bytes[i]);
										}
										const base64 = btoa(binary);
										return {
											id: crypto.randomUUID(),
											type: 'data' as const,
											source: {
												type: 'base64' as const,
												media_type: file.type || 'application/octet-stream',
												data: base64,
											},
											name: file.name,
											created_at: new Date().toISOString(),
										};
									}}
								/>
							</div>
						</div>
					</ResizablePanel>
					{panelLayout.length > 0 && (
						<ResizableHandle withHandle className="bg-transparent w-1.5" />
					)}
					<PanelDock layout={panelLayout} panels={panels} onClosePanel={closePanel} />
				</ResizablePanelGroup>
			</main>
		</>
	);
}
