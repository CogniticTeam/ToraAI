import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { Toaster } from 'sonner';

import { LoginGate } from '@/components/auth/LoginGate';
import { LogoLoader } from '@/components/auth/LoginAnimation';
import { RegionGate } from '@/components/auth/RegionGate';
import { AccountPresence } from '@/components/auth/AccountPresence';
import { RequiredUpdate } from '@/components/auth/RequiredUpdate';
import { queryClient } from '@/lib/query-client';

// 登录页只加载认证所需代码，工作区在身份校验通过后再载入。
const Workspace = lazy(() => import('./Workspace'));

export default function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<div aria-hidden="true" className="app-drag fixed inset-x-0 top-0 z-[200] h-3" />
			<RequiredUpdate><AccountPresence><RegionGate>
				<LoginGate>
					<Suspense fallback={<div className="grid h-screen place-items-center bg-background"><LogoLoader /></div>}>
						<Workspace />
					</Suspense>
				</LoginGate>
			</RegionGate></AccountPresence></RequiredUpdate>
			<Toaster richColors position="top-right" />
		</QueryClientProvider>
	);
}
