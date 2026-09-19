import { format } from 'date-fns';
import {
	BotMessageSquare,
	Cable,
	CalendarClock,
	type LucideIcon,
	Ellipsis,
	FolderOpen,
	MessageSquareDashed,
	Pencil,
	Trash2,
	Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { SessionRecord, SessionSourceKind, SessionView } from '@/api';
import { DeleteDialog } from '@/components/dialog/DeleteDialog';
import { RenameProjectDialog } from '@/components/dialog/RenameProjectDialog';
import { RenameSessionDialog } from '@/components/dialog/RenameSessionDialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useAgents } from '@/hooks/useAgents';
import { useSessions } from '@/hooks/useSessions';
import { useTranslation } from '@/i18n/useI18n.ts';
import {
	getProjectDisplayName,
	projectKey,
	PROJECT_NAMES_CHANGED_EVENT,
	setProjectDisplayName,
} from '@/lib/projectNaming';

// Icon per session origin, shown only when a sidebar mixes sources.
const SOURCE_ICON: Record<SessionSourceKind, LucideIcon> = {
	user: BotMessageSquare,
	schedule: CalendarClock,
	channel: Cable,
	team: Users,
};

type ProjectGroup = {
	key: string;
	cwd: string | null;
	name: string;
	sessions: SessionView[];
};

/** Parse `/chat/:agentId/:sessionId?` out of the location. */
function parseChatPath(pathname: string): {
	agentId: string | null;
	sessionId: string | null;
} {
	const m = pathname.match(/^\/chat(?:\/([\w-]+))?(?:\/([\w-]+))?/);
	return { agentId: m?.[1] ?? null, sessionId: m?.[2] ?? null };
}

/**
 * 历史会话列表（CoCode 定制）：挂在全局侧栏「Skill中心」下方。
 * 会话归属的 agent 取自当前 URL；不在 /chat 路由时回退到第一个智能体。
 *
 * 一级：会话本身，按 updated_at desc 排序。
 */
export function SessionListSection() {
	const navigate = useNavigate();
	const location = useLocation();
	const { t } = useTranslation();
	const { agents } = useAgents();
	const { agentId: urlAgentId, sessionId: urlSessionId } = parseChatPath(location.pathname);
	const agentId = urlAgentId ?? agents[0]?.id ?? null;
	const {
		sessions,
		refetch: refetchSessions,
		update: updateSession,
		remove: removeSession,
	} = useSessions(agentId);

	const [renameOpen, setRenameOpen] = useState(false);
	const [renameSession, setRenameSession] = useState<SessionRecord | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [sessionToDelete, setSessionToDelete] = useState<SessionRecord | null>(null);
	const [renameProjectCwd, setRenameProjectCwd] = useState<string | null>(null);
	const [projectRenameOpen, setProjectRenameOpen] = useState(false);
	const [projectNamesVersion, setProjectNamesVersion] = useState(0);

	useEffect(() => {
		const refreshProjectNames = () => setProjectNamesVersion((version) => version + 1);
		window.addEventListener(PROJECT_NAMES_CHANGED_EVENT, refreshProjectNames);
		return () => window.removeEventListener(PROJECT_NAMES_CHANGED_EVENT, refreshProjectNames);
	}, []);

	// 单一列表按 updated_at desc 排；服务端 listSessionRecords 已按此序排过，
	// 这里再 sort 一次保险（refetch 后可能保持原序）。
	const sortedSessions = useMemo<SessionView[]>(
		() => sessions.slice().sort((a, b) => (a.session.updated_at < b.session.updated_at ? 1 : -1)),
		[sessions],
	);

	// 同一 cwd 的会话归到一个项目；无 cwd 的旧会话保留在独立的未分配分组，
	// 既不丢历史，也不会被错误地归入任意一个已选择的文件夹。
	const projectGroups = useMemo<ProjectGroup[]>(() => {
		const groups = new Map<string, ProjectGroup>();
		for (const view of sortedSessions) {
			const cwd = view.session.config.cwd;
			const key = projectKey(cwd) ?? '__unassigned__';
			const group = groups.get(key) ?? {
				key,
				cwd,
				name: cwd ? getProjectDisplayName(cwd) ?? cwd : t('chat.project.unassigned'),
				sessions: [],
			};
			group.sessions.push(view);
			groups.set(key, group);
		}
		return [...groups.values()];
	}, [projectNamesVersion, sortedSessions, t]);

	const handleDeleteSession = async (sessionId: string) => {
		await removeSession(sessionId);
		if (sessionId === urlSessionId && agentId) {
			navigate(`/chat/${agentId}`, { replace: true });
		}
	};

	const showSourceIcons = useMemo(
		() => new Set(sessions.map((v) => v.session.origin.type)).size > 1,
		[sessions],
	);

	const renderSession = (view: SessionView, index: number) => {
		const session = view.session;
		const SourceIcon = SOURCE_ICON[session.origin.type] ?? BotMessageSquare;
		const active = urlSessionId === session.id;
		return (
			<SidebarMenuItem
				key={session.id}
				className="animate-in fade-in slide-in-from-left-1 duration-300"
				style={{ animationDelay: `${Math.min(index * 40, 400)}ms`, animationFillMode: 'backwards' }}
			>
				<SidebarMenuButton
					className="text-muted-foreground transition-all duration-150 hover:translate-x-0.5 hover:text-foreground active:scale-[0.98] group-has-data-[sidebar=menu-action]/menu-item:pr-16"
					isActive={active}
					onClick={() => navigate(`/chat/${agentId}/${session.id}`)}
				>
					{showSourceIcons && <SourceIcon />}
					<span className="truncate">
						{session.config.name || t('chat.newConversation')}
					</span>
				</SidebarMenuButton>
				<SidebarMenuBadge className="max-md:hidden group-hover/menu-item:hidden group-has-focus-visible/menu-item:hidden group-has-data-[state=open]/menu-item:hidden text-text-tertiary! font-mono">
					{format(new Date(session.created_at), 'HH:mm')}
				</SidebarMenuBadge>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuAction className="md:opacity-0 group-hover/menu-item:opacity-100 group-has-focus-visible/menu-item:opacity-100 aria-expanded:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground">
							<Ellipsis />
						</SidebarMenuAction>
					</DropdownMenuTrigger>
					<DropdownMenuContent className="w-auto" side="right" align="start">
						<DropdownMenuItem
							onClick={() => {
								setRenameSession(session);
								setRenameOpen(true);
							}}
						>
							<Pencil />
							{t('session-menu.rename')}
						</DropdownMenuItem>
						<DropdownMenuItem
							variant="destructive"
							onClick={() => {
								setSessionToDelete(session);
								setDeleteOpen(true);
							}}
						>
							<Trash2 />
							{t('session-menu.delete')}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		);
	};

	const renderProjectGroup = (project: ProjectGroup) => {
		const firstSession = project.sessions[0];
		return (
			<section key={project.key} className="group/project mb-3 last:mb-0">
				<div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm font-medium text-sidebar-foreground">
					<FolderOpen className="size-4 shrink-0" />
					<button
						type="button"
						className="min-w-0 flex-1 truncate text-left"
						title={project.cwd ?? undefined}
						onClick={() => {
							if (agentId && firstSession) {
								navigate(`/chat/${agentId}/${firstSession.session.id}`);
							}
						}}
					>
						{project.name}
					</button>
					{project.cwd && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label={t('chat.project.rename')}
									className="rounded-rect-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-hover/project:opacity-100 focus-visible:opacity-100"
								>
									<Ellipsis className="size-3.5" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-44" side="right" align="start">
								<DropdownMenuItem
									onSelect={() => {
										setRenameProjectCwd(project.cwd);
										setProjectRenameOpen(true);
									}}
								>
									<Pencil />
									{t('chat.project.rename')}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
				<SidebarMenu>{project.sessions.map((view, index) => renderSession(view, index))}</SidebarMenu>
			</section>
		);
	};

	return (
		<SidebarGroup className="app-no-drag mt-1 min-h-0 flex-1 px-2 py-0">
			<SidebarGroupLabel>{t('chat.project.label')}</SidebarGroupLabel>
			<SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
				<div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
					{sessions.length === 0 ? (
						<Empty className="border-none py-4 min-h-50">
							<EmptyHeader>
								<EmptyMedia variant="icon" className="text-primary">
									<MessageSquareDashed />
								</EmptyMedia>
								<EmptyTitle>{t('chat.session.emptyTitle')}</EmptyTitle>
								<EmptyDescription>
									{agentId
										? t('chat.session.emptyHasAgent')
										: t('chat.session.emptyNoAgent')}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : projectGroups.map(renderProjectGroup)}
				</div>
			</SidebarGroupContent>

			<RenameSessionDialog
				open={renameOpen}
				onOpenChange={setRenameOpen}
				// 未命名会话显示「新对话」而不是生硬的会话 id
				currentName={renameSession?.config.name || t('chat.newConversation')}
				onConfirm={async (name) => {
					if (!renameSession) return;
					await updateSession(renameSession.id, { name });
					await refetchSessions();
				}}
			/>
			<RenameProjectDialog
				open={projectRenameOpen}
				onOpenChange={setProjectRenameOpen}
				currentName={renameProjectCwd ? getProjectDisplayName(renameProjectCwd) ?? '' : ''}
				onConfirm={(name) => {
					if (!renameProjectCwd) return;
					setProjectDisplayName(renameProjectCwd, name);
					setProjectNamesVersion((version) => version + 1);
				}}
			/>
			<DeleteDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title={t('common.deleteTitle', {
					entity: t('dialog-session-delete.entity'),
					// 与列表一致：未命名会话显示「新对话」，绝不把会话 id 亮给用户
					name: sessionToDelete?.config.name || t('chat.newConversation'),
				})}
				description={t('common.deleteDescription')}
				confirmLabel={t('dialog-session-delete.confirm')}
				onConfirm={async () => {
					if (sessionToDelete) await handleDeleteSession(sessionToDelete.id);
				}}
			/>
		</SidebarGroup>
	);
}
