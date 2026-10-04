import { motion } from 'framer-motion';
import {
	BookText,
	BotMessageSquare,
	CalendarClock,
	Cat,
	Globe,
	ChevronUp,
	Heart,
	Import,
	Languages,
	LogOut,
	Mail,
	Settings,
	UsersRound,
	Vote,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';

import { useAccountPresence } from '@/components/auth/AccountPresence';
import { ApplicationModeSwitcher } from '@/components/layout/ApplicationModeSwitcher';
import { SessionListSection } from '@/components/layout/SessionListSection';
import { FIRST_RUN_CLOSE_SETTINGS_EVENT, FIRST_RUN_SETTINGS_CLOSED_EVENT } from '@/components/onboarding/constants';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { disableCatgirlLanguagePack } from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';
import { catgirlCopy, useCatgirlSettings } from '@/lib/catgirl';
import { OPEN_SETTINGS_EVENT, type SettingsSection } from '@/lib/openSettings';
import { signOutAccount } from '@/utils/authLogout';
import { getEmail, getToken, getUsername } from '@/utils/authStore';
import { cloudFetch } from '@/utils/modelSync';
const MessagesDialog = lazy(async () => ({ default: (await import('@/components/dialog/MessagesDialog')).MessagesDialog }));
const SponsorsDialog = lazy(async () => ({ default: (await import('@/components/dialog/SponsorsDialog')).SponsorsDialog }));
const LanguageDialog = lazy(async () => ({ default: (await import('@/components/dialog/LanguageDialog')).LanguageDialog }));
const SessionImportDialog = lazy(async () => ({ default: (await import('@/components/dialog/SessionImportDialog')).SessionImportDialog }));

// 共享 layoutId 让两个互斥激活项的指示条在切换时连续滑动（spring 物理感）
const NAV_INDICATOR_LAYOUT_ID = 'tora-sidebar-nav-indicator';

interface ToraWindowBridge {
	platform?: string;
	hasNativeTitlebar?: boolean;
	isMaximized(): boolean;
	isFullScreen?(): boolean;
	onMaximizeChange(cb: (expanded: boolean) => void): (() => void) | void;
	onOpenMessagesFromNotification?: (cb: () => void) => () => void;
}

function getWindowBridge(): ToraWindowBridge | undefined {
	return (window as unknown as { toraWindow?: ToraWindowBridge }).toraWindow;
}

// 设置是用户触发的模态层；首屏任务页不预载它，缩短已登录用户的可交互时间。
const SettingsDialog = lazy(async () => ({
	default: (await import('@/components/dialog/SettingsDialog')).SettingsDialog,
}));

type NavigationMotion = 'off' | 'gentle' | 'standard' | 'fast';
const NAV_TRANSITIONS = {
	off: { duration: 0 },
	gentle: { type: 'spring' as const, stiffness: 250, damping: 30, mass: 0.7 },
	standard: { type: 'spring' as const, stiffness: 380, damping: 30, mass: 0.6 },
	fast: { type: 'spring' as const, stiffness: 620, damping: 42, mass: 0.5 },
};

function NavIndicator({ visible, motionMode }: { visible: boolean; motionMode: NavigationMotion }) {
	if (!visible) return null;
	return (
		<motion.span
			layoutId={motionMode === 'off' ? undefined : NAV_INDICATOR_LAYOUT_ID}
			className="pointer-events-none absolute inset-y-1.5 left-0 w-[3px] rounded-[1px] bg-primary"
			transition={NAV_TRANSITIONS[motionMode]}
		/>
	);
}

export function AppSidebar({ navigationMotion }: { navigationMotion: NavigationMotion }) {
	const navigate = useNavigate();
	const location = useLocation();
	const newTaskActive = /^\/(?:chat|tochat)(?:\/[\w-]+)?\/?$/.test(location.pathname);
	const { t, i18n } = useTranslation();
	const { installed: catgirlInstalled } = useCatgirlSettings();
	const [catgirlBusy, setCatgirlBusy] = useState(false);
	const catgirlLabels = catgirlCopy(i18n.language);
	const disableCatgirl = async () => {
		if (catgirlBusy) return;
		setCatgirlBusy(true);
		try { await disableCatgirlLanguagePack(); }
		catch { toast.error(catgirlLabels.disableError); }
		finally { setCatgirlBusy(false); }
	};
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [messagesOpen, setMessagesOpen] = useState(false);
	const [languageOpen, setLanguageOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	useEffect(() => getWindowBridge()?.onOpenMessagesFromNotification?.(() => setMessagesOpen(true)), []);
	const [sponsorsMode, setSponsorsMode] = useState<'list' | 'donate' | null>(null);
	const { unread } = useAccountPresence();
	const [settingsTab, setSettingsTab] = useState<SettingsSection>('general');
	const handleSettingsOpenChange = useCallback((open: boolean) => {
		setSettingsOpen(open);
		if (!open) window.dispatchEvent(new Event(FIRST_RUN_SETTINGS_CLOSED_EVENT));
	}, []);
	useEffect(() => {
		const close = () => handleSettingsOpenChange(false);
		window.addEventListener(FIRST_RUN_CLOSE_SETTINGS_EVENT, close);
		return () => window.removeEventListener(FIRST_RUN_CLOSE_SETTINGS_EVENT, close);
	}, [handleSettingsOpenChange]);
	const [accountName, setAccountName] = useState(() => getUsername() || getEmail()?.split('@')[0] || 'Tora');
	const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
	const [pollsEnabled, setPollsEnabled] = useState(() => localStorage.getItem('tora_polls_enabled') !== '0');
	const [pollEntryVisible, setPollEntryVisible] = useState(() => localStorage.getItem('tora_poll_entry_visible') !== '0');
	useEffect(() => {
		let alive = true;
		const refresh = async () => {
			try {
				const response = await cloudFetch('/polls/config');
				if (!response.ok) return;
				const body = await response.json() as { enabled?: boolean; entryVisible?: boolean };
				if (!alive) return;
				if (typeof body.enabled === 'boolean') {
					setPollsEnabled(body.enabled);
					localStorage.setItem('tora_polls_enabled', body.enabled ? '1' : '0');
				}
				if (typeof body.entryVisible === 'boolean') {
					setPollEntryVisible(body.entryVisible);
					localStorage.setItem('tora_poll_entry_visible', body.entryVisible ? '1' : '0');
				}
			} catch { /* 离线沿用最近一次设置 */ }
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 30000);
		window.addEventListener('tora-auth-changed', refresh);
		window.addEventListener('focus', refresh);
		return () => { alive = false; window.clearInterval(timer); window.removeEventListener('tora-auth-changed', refresh); window.removeEventListener('focus', refresh); };
	}, []);

	// 全局事件桥：任意页面 openSettings('model') → 此处打开设置窗口并定位板块
	useEffect(() => {
		const handler = (e: Event) => {
			setSettingsTab((e as CustomEvent<SettingsSection>).detail ?? 'general');
			setSettingsOpen(true);
		};
		window.addEventListener(OPEN_SETTINGS_EVENT, handler);
		return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler);
	}, []);

	useEffect(() => {
		let alive = true;
		const loadAccount = async () => {
			const fallbackName = getUsername() || getEmail()?.split('@')[0] || 'Tora';
			setAccountName(fallbackName);
			const token = getToken();
			if (!token) {
				setAvatarUrl(null);
				return;
			}
			try {
				const response = await cloudFetch('/auth/me');
				if (!response.ok) return;
				const body = (await response.json()) as {
					username?: string;
					email?: string;
					avatar?: string | null;
				};
				if (!alive) return;
				setAccountName(body.username || body.email?.split('@')[0] || fallbackName);
				setAvatarUrl(typeof body.avatar === 'string' && body.avatar ? body.avatar : null);
			} catch {
				// 保留本地账号信息和首字母头像作为离线兜底。
			}
		};
		const syncAccount = () => void loadAccount();
		void loadAccount();
		window.addEventListener('tora-auth-changed', syncAccount);
		return () => {
			alive = false;
			window.removeEventListener('tora-auth-changed', syncAccount);
		};
	}, []);

	// 新任务只进入草稿页，首次发送再建会话。裸 /chat 用于恢复上次会话，
	// 所以从其它页面新建时明确携带意图，避免恢复逻辑把用户送回旧会话。
	const handleNewTask = useCallback(() => {
		if (location.pathname.startsWith('/tochat')) {
			const agentId = location.pathname.split('/')[2];
			const task = new URLSearchParams(location.search).get('task') === 'work' ? 'work' : 'chat';
			navigate(`${agentId ? `/tochat/${agentId}` : '/tochat'}?task=${task}`);
			return;
		}
		const agentId = location.pathname.match(/^\/chat\/([\w-]+)/)?.[1];
		navigate(agentId ? `/chat/${agentId}` : '/chat?new=1');
	}, [location.pathname, location.search, navigate]);

	// Logo 在全屏中仍显示；只有普通 macOS 窗口需要给原生按钮让位。
	const fullscreen = useMacFullscreen();
	const nativeTitlebar = getWindowBridge()?.hasNativeTitlebar === true;

	useEffect(() => {
		const bridge = (window as unknown as { toraWindow?: { onMenuCommand?: (cb: (action: string) => void) => () => void } }).toraWindow;
		return bridge?.onMenuCommand?.(action => {
			if (action === 'new-task') void handleNewTask();
			if (action === 'messages') setMessagesOpen(true);
			if (action === 'settings' || action === 'models') { setSettingsTab(action === 'models' ? 'model' : 'general'); setSettingsOpen(true); }
			if (action === 'browser') navigate('/browser');
			if (action === 'automations') navigate('/schedule');
			if (action === 'skills') navigate('/skill');
		});
	}, [handleNewTask, navigate]);

	return (
		// 展开态导航栏：256px (w-64，与 sidebar.tsx 的 SIDEBAR_WIDTH 一致)。
		// 原来用 w-80 (320px)，右侧面板（尤其内置浏览器）打开后主内容区被压到
		// 最小宽度 24rem + 面板列 20rem，窄窗口下几乎没有余量，故收窄 64px 让位。
		// 会话名本身是 truncate 的，且默认展开态下最多 6~8 个汉字就够分辨，
		// 收窄后仍可用。collapsible="none" 保证永不折叠。
		// 保留 新任务、自动化、Skill 中心、浏览器与可由管理员关闭的投票入口（频道/凭证/知识库/MCP 已隐藏，
		// 对应路由与页面仍可用，只是不在导航展示）。
		// 「自动化」复用已有的 /schedule 路由与页面（定时任务/自动化任务）。
		// 「浏览器」是全屏内置浏览器入口，复用 /browser 路由页（常驻 webview，见 BrowserPanel）。
		//
		// 拖拽区（-webkit-app-region: drag）**只**留在 SidebarHeader 的标题条上。
		// 不要把 app-drag 加到 Sidebar / SidebarContent：整条侧栏作为拖拽区时，
		// 内部再靠 app-no-drag 逐块"挖洞"在 Electron 里并不可靠（尤其
		// SidebarContent 还带 overflow-auto，Chromium 不支持滚动区当拖拽区），
		// 会表现为侧栏按钮点不动。窗口拖动有标题条 + 主内容区顶栏两处足够。
		<Sidebar collapsible="none" className="w-72! border-r border-sidebar-border bg-sidebar">
			{!nativeTitlebar && <SidebarHeader className="h-12 shrink-0 p-0">
				<div data-testid="sidebar-brand" className={`app-drag flex h-12 items-center gap-2 pe-4 ${getWindowBridge()?.platform === 'darwin' && !fullscreen ? 'ps-24' : 'ps-4'}`}>
					<img src="/icon.png" alt="" width={20} height={20} draggable={false} className="size-5 shrink-0 rounded-[5px] grayscale" />
					<span className="text-base font-semibold tracking-tight text-foreground">Tora</span>
				</div>
			</SidebarHeader>}
			<SidebarContent>
				<ApplicationModeSwitcher />
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem key={'chat'}>
								<NavIndicator
									motionMode={navigationMotion}
									visible={newTaskActive}
								/>
								<SidebarMenuButton
									isActive={newTaskActive}
									data-testid="new-conversation"
									onClick={() => void handleNewTask()}
								>
									<BotMessageSquare />
									<span>{t(location.pathname.startsWith('/tochat') ? 'chat.newConversation' : 'common.new-task')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							{/* 自动化：复用已有的 /schedule 路由（定时任务），置于 新任务 与 技能中心 之间 */}
							<SidebarMenuItem key={'automation'}>
								<NavIndicator motionMode={navigationMotion} visible={location.pathname.startsWith('/schedule')} />
								<SidebarMenuButton
									id="tour-automation-nav"
									isActive={location.pathname.startsWith('/schedule')}
									onClick={() => navigate('/schedule')}
								>
									<CalendarClock />
									<span>{t('common.automation')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem>
								<NavIndicator motionMode={navigationMotion} visible={location.pathname.startsWith('/skill')} />
								<SidebarMenuButton
									id="tour-skills-nav"
									isActive={location.pathname.startsWith('/skill')}
									onClick={() => navigate('/skill')}
								>
									<BookText />
									<span>{t('common.skill-hub')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							{/* 浏览器：全屏内置浏览器，置于 技能中心 之下 */}
							<SidebarMenuItem key={'browser'}>
								<NavIndicator motionMode={navigationMotion} visible={location.pathname.startsWith('/browser')} />
								<SidebarMenuButton
									id="tour-browser-nav"
									isActive={location.pathname.startsWith('/browser')}
									onClick={() => navigate('/browser')}
								>
									<Globe />
									<span>{t('common.browser')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							{pollsEnabled && pollEntryVisible && <SidebarMenuItem key={'polls'}>
								<NavIndicator motionMode={navigationMotion} visible={location.pathname.startsWith('/polls')} />
								<SidebarMenuButton isActive={location.pathname.startsWith('/polls')} onClick={() => navigate('/polls')}>
									<Vote />
									<span>{t('common.polls')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
				{/* 历史会话：菜单项之下（Tora 定制，自聊天页侧栏迁入） */}
				<SessionListSection />
			</SidebarContent>
			<SidebarFooter className="p-2">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton className="h-10 rounded-rect px-2">
							<Avatar className="size-6 rounded-full">
								<AvatarImage src={avatarUrl ?? undefined} alt={accountName} />
								<AvatarFallback className="rounded-full bg-foreground text-[11px] text-background">
									{accountName.slice(0, 1).toUpperCase()}
								</AvatarFallback>
							</Avatar>
							<span className="min-w-0 flex-1 truncate font-medium">{accountName}</span>
							<ChevronUp className="size-4 text-muted-foreground" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" align="start" className="w-52 p-1">
						<DropdownMenuItem className="py-1 text-[13px]" onClick={() => setMessagesOpen(true)}>
							<Mail /><span className="flex-1">{t('inbox.title')}</span>
							{unread > 0 && <span className="text-xs text-muted-foreground">{unread}</span>}
						</DropdownMenuItem>
						<DropdownMenuItem className="py-1 text-[13px]" onClick={() => setSponsorsMode('list')}>
							<UsersRound /><span>{t('sponsors.title')}</span>
						</DropdownMenuItem>
						<DropdownMenuItem className="py-1 text-[13px]" onClick={() => setSponsorsMode('donate')}>
							<Heart /><span>{t('sponsors.donate')}</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							className="py-1 text-[13px]"
							onClick={() => {
								setSettingsTab('general');
								setSettingsOpen(true);
							}}
						>
							<Settings />
							<span>{t('common.settings')}</span>
						</DropdownMenuItem>
						<DropdownMenuItem className="py-1 text-[13px]" onClick={() => setLanguageOpen(true)}>
							<Languages />
							<span>{t('settings.general.language.title')}</span>
						</DropdownMenuItem>
						{catgirlInstalled && <DropdownMenuItem className="py-1 text-[13px]"
							data-testid="disable-catgirl-language-pack" disabled={catgirlBusy}
							onSelect={() => void disableCatgirl()}>
							<Cat /><span className="whitespace-normal">{catgirlBusy ? catgirlLabels.disabling : catgirlLabels.disable}</span>
						</DropdownMenuItem>}
						<DropdownMenuSeparator />
						<DropdownMenuItem className="py-1 text-[13px]" data-testid="open-session-import" onSelect={() => setImportOpen(true)}>
							<Import /><span>{t('sessionImport.title')}</span>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem className="py-1 text-[13px]" data-testid="account-sign-out" onSelect={() => void signOutAccount().catch(() => toast.error(t('common.error')))}>
							<LogOut />
							<span>{t('settings.account.logout')}</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarFooter>
			{/* key=settingsTab：同一 tab 重开时靠 open effect 复位；不同 tab 重挂载强制切换 */}
			{messagesOpen && <Suspense fallback={null}><MessagesDialog onClose={() => setMessagesOpen(false)} /></Suspense>}
			{languageOpen && <Suspense fallback={null}><LanguageDialog onClose={() => setLanguageOpen(false)} /></Suspense>}
			{importOpen && <Suspense fallback={null}><SessionImportDialog onClose={() => setImportOpen(false)} /></Suspense>}
			{sponsorsMode && <Suspense fallback={null}><SponsorsDialog mode={sponsorsMode} onClose={() => setSponsorsMode(null)} /></Suspense>}
			{settingsOpen && (
				<Suspense fallback={null}>
					<SettingsDialog
						key={settingsTab}
						open={settingsOpen}
						onOpenChange={handleSettingsOpenChange}
						initialTab={settingsTab}
					/>
				</Suspense>
			)}
		</Sidebar>
	);
}
