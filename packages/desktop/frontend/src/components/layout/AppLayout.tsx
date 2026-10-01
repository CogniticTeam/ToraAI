import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { TokenMilestoneDialog } from '@/components/dialog/TokenMilestoneDialog';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { FirstRunTour } from '@/components/onboarding/FirstRunTour';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useMotionSettings } from '@/hooks/useMotionSettings';

const ROUTE_MOTION = {
	off: { initial: { opacity: 1, y: 0 }, exit: { opacity: 1, y: 0 }, duration: 0 },
	gentle: { initial: { opacity: 0.94, y: 4 }, exit: { opacity: 0.98, y: -3 }, duration: 0.26 },
	standard: { initial: { opacity: 0.9, y: 8 }, exit: { opacity: 0.94, y: -5 }, duration: 0.2 },
	fast: { initial: { opacity: 0.96, y: 3 }, exit: { opacity: 0.97, y: -2 }, duration: 0.12 },
} as const;

export function AppLayout() {
	const location = useLocation();
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
					<AppSidebar navigationMotion={pageEnabled ? effective : 'off'} />
					<SidebarInset className="flex-1 overflow-hidden bg-transparent">
						{/* 路由切换保持快速连续；具体幅度和时长由主题页配置，减少动态时瞬时切换。
						   mode="popLayout" 让退出动画期间新页也能即时挂载，避免白屏。
						   用 location.pathname 作 key —— 同路径子参数变更不重挂载。 */}
						<AnimatePresence mode="popLayout" initial={false}>
							<motion.div
								ref={contentRef}
								key={location.pathname}
								tabIndex={-1}
								initial={routeMotion.initial}
								animate={{ opacity: 1, y: 0 }}
								exit={routeMotion.exit}
								transition={{ duration: routeMotion.duration, ease: [0.2, 0.8, 0.2, 1] }}
								className="h-full w-full bg-transparent outline-none"
							>
								<Outlet />
							</motion.div>
						</AnimatePresence>
					</SidebarInset>
					<FirstRunTour />
					<TokenMilestoneDialog />
				</SidebarProvider>
			</MotionConfig>
		</div>
	);
}
