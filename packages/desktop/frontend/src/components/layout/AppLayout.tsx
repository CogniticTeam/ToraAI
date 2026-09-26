import { AnimatePresence, motion } from 'framer-motion';
import { Outlet, useLocation } from 'react-router-dom';

import { AppSidebar } from '@/components/layout/AppSidebar';
import { FirstRunTour } from '@/components/onboarding/FirstRunTour';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

export function AppLayout() {
	const location = useLocation();
	return (
		<div className="app-wallpaper h-screen flex">
			<SidebarProvider>
				<AppSidebar />
				<SidebarInset className="flex-1 overflow-hidden bg-transparent">
					{/* 路由切换时旧页 fade-out，新页 fade+scale-in。
					   mode="popLayout" 让退出动画期间新页也能即时挂载，避免白屏。
					   用 location.pathname 作 key —— 同路径子参数变更不重挂载。 */}
					<AnimatePresence mode="popLayout" initial={false}>
						<motion.div
							key={location.pathname}
							initial={{ opacity: 0, scale: 0.985 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={{ opacity: 0, scale: 0.99 }}
							transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
							className="h-full w-full bg-transparent"
						>
							<Outlet />
						</motion.div>
					</AnimatePresence>
				</SidebarInset>
				<FirstRunTour />
			</SidebarProvider>
		</div>
	);
}
