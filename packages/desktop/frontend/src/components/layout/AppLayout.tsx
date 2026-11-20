import { MotionConfig, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { hasFreshlyCreated } from '@/api/session';
import { TokenMilestoneDialog } from '@/components/dialog/TokenMilestoneDialog';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { FirstRunTour } from '@/components/onboarding/FirstRunTour';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useMotionSettings } from '@/hooks/useMotionSettings';

const ROUTE_MOTION = {
	off: { initial: { opacity: 1 }, duration: 0 },
	gentle: { initial: { opacity: 0 }, duration: 0.28 },
	standard: { initial: { opacity: 0 }, duration: 0.28 },
	fast: { initial: { opacity: 0 }, duration: 0.18 },
} as const;

export function AppLayout() {
	const location = useLocation();
	// Creating the first session changes only its URL, not the conversation.
	// Remounting here discards the optimistic user message before /chat accepts it.
	const [previous, setPrevious] = useState({ path: location.pathname, key: location.pathname });
	const createdRoute = /^\/(chat|tochat)\/([^/]+)\/([^/]+)\/?$/.exec(location.pathname);
	const previousPath = previous.path.replace(/\/+$/, '');
	const adoptsDraft = createdRoute && hasFreshlyCreated(createdRoute[3]) &&
		(previousPath === `/${createdRoute[1]}/${createdRoute[2]}` || previousPath === `/${createdRoute[1]}`);
	const routeKey = previous.path === location.pathname || adoptsDraft ? previous.key : location.pathname;
	if (previous.path !== location.pathname) {
		setPrevious({ path: location.pathname, key: routeKey });
	}
	const { effective, pageEnabled } = useMotionSettings();
	const routeMotion = ROUTE_MOTION[pageEnabled ? effective : 'off'];
	const contentRef = useRef<HTMLDivElement>(null);
	const previousSection = useRef(location.pathname.split('/')[1]);
	useEffect(() => {
		const section = location.pathname.split('/')[1];
		if (previousSection.current === section) return;
		previousSection.current = section;
		const frame = requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true }));
		return () => cancelAnimationFrame(frame);
	}, [location.pathname]);
	return (
		<div className="app-wallpaper h-screen flex">
			<MotionConfig reducedMotion={effective === 'off' ? 'always' : 'user'}>
				<SidebarProvider>
					<AppSidebar />
					<SidebarInset className="flex-1 overflow-hidden bg-transparent p-2 ps-0">
						{/* 始终只挂载一个 Outlet。退出页也会读取新路由，保留它会造成
						   标题、输入框和订阅重复。首次建会话只接管地址，保留消息；其它切换与导航高亮同一时长交叉淡入。 */}
						<motion.div
							ref={contentRef}
							key={routeKey}
							data-app-route-content
							tabIndex={-1}
							initial={routeMotion.duration === 0 ? false : routeMotion.initial}
							animate={{ opacity: 1 }}
							transition={{ duration: routeMotion.duration, ease: [0.22, 1, 0.36, 1] }}
							className="app-stage min-h-0 w-full flex-1 overflow-hidden outline-none"
						>
							<Outlet />
						</motion.div>
					</SidebarInset>
					<FirstRunTour />
					<TokenMilestoneDialog />
				</SidebarProvider>
			</MotionConfig>
		</div>
	);
}
