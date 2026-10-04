import { MotionConfig, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { TokenMilestoneDialog } from '@/components/dialog/TokenMilestoneDialog';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { FirstRunTour } from '@/components/onboarding/FirstRunTour';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useMotionSettings } from '@/hooks/useMotionSettings';

const ROUTE_MOTION = {
	off: { initial: { opacity: 1, y: 0 }, duration: 0 },
	gentle: { initial: { opacity: 0.94, y: 4 }, duration: 0.26 },
	standard: { initial: { opacity: 0.9, y: 8 }, duration: 0.2 },
	fast: { initial: { opacity: 0.96, y: 3 }, duration: 0.12 },
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
						{/* 始终只挂载一个 Outlet。退出页也会读取新路由，保留它会造成
						   标题、输入框和订阅重复；切换时立即卸载旧页，仅播放新页入场。 */}
						<motion.div
							ref={contentRef}
							key={location.pathname}
							data-app-route-content
							tabIndex={-1}
							initial={routeMotion.initial}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: routeMotion.duration, ease: [0.2, 0.8, 0.2, 1] }}
							className="h-full w-full bg-transparent outline-none"
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
