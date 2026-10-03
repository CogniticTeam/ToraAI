import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { Toaster } from 'sonner';

import { AccountPresence } from '@/components/auth/AccountPresence';
import { FirstUseConsent } from '@/components/auth/FirstUseConsent';
import { LogoLoader } from '@/components/auth/LoginAnimation';
import { LoginGate } from '@/components/auth/LoginGate';
import { RequiredUpdate } from '@/components/auth/RequiredUpdate';
import { WindowDragRegion } from '@/components/layout/WindowDragRegion';
import { FirstLaunchIntro } from '@/components/onboarding/FirstLaunchIntro';
import { queryClient } from '@/lib/query-client';

// 登录页只加载认证所需代码，工作区在身份校验通过后再载入。
const Workspace = lazy(() => import('./Workspace'));

export default function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<WindowDragRegion data-testid="global-window-drag-region" className="fixed inset-x-0 top-0 z-[200] h-4" />
			<RequiredUpdate><FirstLaunchIntro><FirstUseConsent><AccountPresence>
				<LoginGate>
					<Suspense fallback={<div className="grid h-screen place-items-center bg-background"><LogoLoader /></div>}>
						<Workspace />
					</Suspense>
				</LoginGate>
			</AccountPresence></FirstUseConsent></FirstLaunchIntro></RequiredUpdate>
			<Toaster richColors position="top-right" />
		</QueryClientProvider>
	);
}
