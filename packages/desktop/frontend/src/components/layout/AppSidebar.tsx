import { motion } from 'framer-motion';
import {
	BookText,
	BotMessageSquare,
	CalendarClock,
	Coins,
	Crown,
	Globe,
	ChevronUp,
	Languages,
	Settings,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

import { agentApi, sessionApi } from '@/api';
import { SettingsDialog } from '@/components/dialog/SettingsDialog';
import { SubscriptionDialog } from '@/components/dialog/SubscriptionDialog';
import { SessionListSection } from '@/components/layout/SessionListSection';
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
import { useCreditsBalance } from '@/hooks/useCreditsBalance';
import i18n from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';
import { OPEN_SETTINGS_EVENT, OPEN_SUBSCRIPTION_EVENT, type SettingsSection } from '@/lib/openSettings';
import { getEmail, getToken, getUsername } from '@/utils/authStore';
import { cloudFetch } from '@/utils/modelSync';

// 共享 layoutId 让两个互斥激活项的指示条在切换时连续滑动（spring 物理感）
const NAV_INDICATOR_LAYOUT_ID = 'cocode-sidebar-nav-indicator';

function NavIndicator({ visible }: { visible: boolean }) {
	if (!visible) return null;
	return (
		<motion.span
			layoutId={NAV_INDICATOR_LAYOUT_ID}
			className="pointer-events-none absolute inset-y-1.5 left-0 w-[3px] rounded-[1px] bg-primary"
			transition={{ type: 'spring', stiffness: 380, damping: 30, mass: 0.6 }}
		/>
	);
}

export function AppSidebar() {
	const navigate = useNavigate();
	const location = useLocation();
	const { t } = useTranslation();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsTab, setSettingsTab] = useState<SettingsSection>('general');
	const [subscriptionOpen, setSubscriptionOpen] = useState(false);
	const [accountName, setAccountName] = useState(() => getUsername() || getEmail()?.split('@')[0] || 'CoCode');
	const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
	// 侧边栏积分余额：拉取 + 登录态/积分变动事件 + 轮询（见 useCreditsBalance）
	const { signedIn, credits } = useCreditsBalance();

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
			const fallbackName = getUsername() || getEmail()?.split('@')[0] || 'CoCode';
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
		window.addEventListener('cocode-auth-changed', syncAccount);
		return () => {
			alive = false;
			window.removeEventListener('cocode-auth-changed', syncAccount);
		};
	}, []);

	// 全局事件桥：账户页「查看套餐 / 去兑换积分」→ 打开订阅窗口
	useEffect(() => {
		const handler = () => setSubscriptionOpen(true);
		window.addEventListener(OPEN_SUBSCRIPTION_EVENT, handler);
		return () => window.removeEventListener(OPEN_SUBSCRIPTION_EVENT, handler);
	}, []);

	// 「新任务」自动建会话：
	// - 已在某会话里 → 仅回到 /chat（空态，由用户从列表挑选或再点新任务）；
	// - 不在任何会话里（空态页/其它页面）→ 直接创建新会话并跳进去，
	//   免去"点了新任务还得手动点进会话"的一步。
	// agent 未定（URL 无 agentId）时用记住的 agent，再退回第一个 agent。
	const handleNewTask = useCallback(async () => {
		const inSession = /^\/chat\/[\w-]+\/[\w-]+/.test(location.pathname);
		if (inSession) {
			navigate('/chat');
			return;
		}
		const remembered =
			localStorage.getItem('chat_last_agent') ??
			(location.pathname.match(/^\/chat\/([\w-]+)/)?.[1] ?? null);
		try {
			const agents = await agentApi.list();
			const agentId =
				(remembered && agents.agents.some((a) => a.id === remembered) ? remembered : null) ??
				agents.agents[0]?.id;
			if (!agentId) {
				navigate('/chat');
				return;
			}
			const res = await sessionApi.create({ agent_id: agentId });
			navigate(`/chat/${agentId}/${res.session_id}`);
		} catch {
			// 建会话失败（网络/无 agent）：退回老路径，让 ChatPage 自行恢复
			navigate('/chat');
		}
	}, [location.pathname, navigate]);

	// 无边框窗口：最大化/全屏时 macOS 红绿灯自动隐藏，CoCode 靠左；普通窗口让位红绿灯。
	// Electron 由 preload 桥（window.cocodeWindow）提供状态；浏览器环境无红绿灯，直接靠左。
	interface CocodeWindowBridge {
		isMaximized(): boolean;
		onMaximizeChange(cb: (maximized: boolean) => void): void;
	}
	const getWindowBridge = (): CocodeWindowBridge | undefined =>
		(window as unknown as { cocodeWindow?: CocodeWindowBridge }).cocodeWindow;
	const [lightedPinned, setLightedPinned] = useState(!!getWindowBridge());
	useEffect(() => {
		const bridge = getWindowBridge();
		if (!bridge) return;
		setLightedPinned(!bridge.isMaximized());
		bridge.onMaximizeChange((maxed: boolean) => setLightedPinned(!maxed));
	}, []);

	const handleToggleLanguage = () => {
		const next = i18n.language.startsWith('zh') ? 'en' : 'zh';
		i18n.changeLanguage(next);
	};

	return (
		// 展开态导航栏：256px (w-64，与 sidebar.tsx 的 SIDEBAR_WIDTH 一致)。
		// 原来用 w-80 (320px)，右侧面板（尤其内置浏览器）打开后主内容区被压到
		// 最小宽度 24rem + 面板列 20rem，窄窗口下几乎没有余量，故收窄 64px 让位。
		// 会话名本身是 truncate 的，且默认展开态下最多 6~8 个汉字就够分辨，
		// 收窄后仍可用。collapsible="none" 保证永不折叠。
		// 仅保留 新任务、自动化、Skill 中心 与 浏览器 四个入口（频道/凭证/知识库/MCP 已隐藏，
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
			<SidebarHeader>
				{/* 无边框窗口：此条为窗口拖拽区。普通窗口 pl-20 让位悬浮红绿灯；最大化（红绿灯隐藏）或浏览器 pl-4 靠左 */}
				<div className={`app-drag flex h-11 items-center gap-2 transition-[padding] ${lightedPinned ? 'pl-20' : 'pl-4'}`}>
					<img src="/icon.png" alt="" width={20} height={20} draggable={false} className="size-5 shrink-0 rounded-[5px] grayscale" />
					<span className="text-base font-semibold tracking-tight text-foreground">CoCode</span>
				</div>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem key={'chat'}>
								<NavIndicator
									visible={
										location.pathname === '/chat' ||
										location.pathname.startsWith('/chat/')
									}
								/>
								<SidebarMenuButton
									isActive={
										location.pathname === '/chat' ||
										location.pathname.startsWith('/chat/')
									}
									onClick={() => void handleNewTask()}
								>
									<BotMessageSquare />
									<span>{t('common.new-task')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							{/* 自动化：复用已有的 /schedule 路由（定时任务），置于 新任务 与 技能中心 之间 */}
							<SidebarMenuItem key={'automation'}>
								<NavIndicator visible={location.pathname.startsWith('/schedule')} />
								<SidebarMenuButton
									isActive={location.pathname.startsWith('/schedule')}
									onClick={() => navigate('/schedule')}
								>
									<CalendarClock />
									<span>{t('common.automation')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem>
								<NavIndicator visible={location.pathname.startsWith('/skill')} />
								<SidebarMenuButton
									isActive={location.pathname.startsWith('/skill')}
									onClick={() => navigate('/skill')}
								>
									<BookText />
									<span>{t('common.skill-hub')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							{/* 浏览器：全屏内置浏览器，置于 技能中心 之下 */}
							<SidebarMenuItem key={'browser'}>
								<NavIndicator visible={location.pathname.startsWith('/browser')} />
								<SidebarMenuButton
									isActive={location.pathname.startsWith('/browser')}
									onClick={() => navigate('/browser')}
								>
									<Globe />
									<span>{t('common.browser')}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
				{/* 历史会话：菜单项之下（CoCode 定制，自聊天页侧栏迁入） */}
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
						<DropdownMenuItem className="py-1 text-[13px]" onClick={() => setSubscriptionOpen(true)}>
							<Crown />
							<span>{t('common.subscription')}</span>
						</DropdownMenuItem>
						<DropdownMenuItem className="py-1 text-[13px]" onClick={() => setSubscriptionOpen(true)}>
							<Coins />
							<span className="flex-1">{t('subscription.credits')}</span>
							<span className="tabular-nums text-xs text-muted-foreground">
								{signedIn ? (credits === null ? '--' : credits.toLocaleString()) : '--'}
							</span>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem className="py-1 text-[13px]" onClick={handleToggleLanguage}>
							<Languages />
							<span>
								{i18n.language.startsWith('zh')
									? t('common.switchToEn')
									: t('common.switchToZh')}
							</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarFooter>
			{/* key=settingsTab：同一 tab 重开时靠 open effect 复位；不同 tab 重挂载强制切换 */}
			<SettingsDialog
				key={settingsTab}
				open={settingsOpen}
				onOpenChange={setSettingsOpen}
				initialTab={settingsTab}
			/>
			<SubscriptionDialog open={subscriptionOpen} onOpenChange={setSubscriptionOpen} />
		</Sidebar>
	);
}
