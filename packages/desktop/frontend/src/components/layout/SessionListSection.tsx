import { format } from 'date-fns';
import {
	BotMessageSquare,
	Cable,
	CalendarClock,
	type LucideIcon,
	Ellipsis,
	MessageSquareDashed,
	Pencil,
	Trash2,
	Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import {sessionHistoryKind} from '../../../../../core/src/session-mode.js';
import type { SessionRecord, SessionSourceKind, SessionView } from '@/api';
import { DeleteDialog } from '@/components/dialog/DeleteDialog';
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

// Icon per session origin, shown only when a sidebar mixes sources.
const SOURCE_ICON: Record<SessionSourceKind, LucideIcon> = {
	user: BotMessageSquare,
	schedule: CalendarClock,
	channel: Cable,
	team: Users,
};

/** Parse `/chat/:agentId/:sessionId?` out of the location. */
function parseChatPath(pathname: string): {
	agentId: string | null;
	sessionId: string | null;
} {
	const m = pathname.match(/^\/(?:chat|tochat)(?:\/([\w-]+))?(?:\/([\w-]+))?/);
	return { agentId: m?.[1] ?? null, sessionId: m?.[2] ?? null };
}

/**
 * 历史会话列表（Tora 定制）：挂在全局侧栏「Skill中心」下方。
 * 会话归属的 agent 取自当前 URL；不在 /chat 路由时回退到第一个智能体。
 *
 * 一级：会话本身，按 updated_at desc 排序。
 */
export function SessionListSection() {
	const navigate = useNavigate();
	const location = useLocation();
	const tochat = location.pathname.startsWith('/tochat');
	const routeBase = tochat ? '/tochat' : '/chat';
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
	// 单一列表按 updated_at desc 排；服务端 listSessionRecords 已按此序排过，
	// 这里再 sort 一次保险（refetch 后可能保持原序）。
	const selected = sessions.find(view=>view.session.id===urlSessionId);
	const historyKind = tochat ? selected ? sessionHistoryKind(selected.session.config) : new URLSearchParams(location.search).get('task')==='work'?'work':'chat' : 'work';
	const routeQuery = tochat ? `?task=${historyKind}` : '';
	const sortedSessions = useMemo<SessionView[]>(
		() => sessions.filter(view=>sessionHistoryKind(view.session.config)===historyKind)
			.sort((a,b)=>String(b.session.updated_at??b.session.created_at??'').localeCompare(String(a.session.updated_at??a.session.created_at??''))),
		[sessions,historyKind],
	);

	const handleDeleteSession = async (sessionId: string) => {
		await removeSession(sessionId);
		if (sessionId === urlSessionId && agentId) {
			navigate(`${routeBase}/${agentId}${routeQuery}`, { replace: true });
		}
	};

	const showSourceIcons = useMemo(
		() => new Set(sortedSessions.map((v) => v.session.origin.type)).size > 1,
		[sortedSessions],
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
					onClick={() => navigate(`${routeBase}/${agentId}/${session.id}${routeQuery}`)}
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


	return (
		<SidebarGroup className="app-no-drag mt-1 min-h-0 flex-1 px-2 py-0">
			<SidebarGroupLabel>{t('conversationList.title')}</SidebarGroupLabel>
			<SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
				<div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
					{sortedSessions.length === 0 ? (
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
					) : <SidebarMenu>{sortedSessions.map(renderSession)}</SidebarMenu>}
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
