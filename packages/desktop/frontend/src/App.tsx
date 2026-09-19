import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { Toaster } from 'sonner';

import { MCPHubPage } from './pages/mcp';
import { SkillHubPage } from './pages/skill';
import { LoginGate } from '@/components/auth/LoginGate';
import { RegionGate } from '@/components/auth/RegionGate';
import { RouteError } from '@/components/error/RouteError';
import { AppLayout } from '@/components/layout/AppLayout';
import { UploadProvider } from '@/context/UploadContext';
import { queryClient } from '@/lib/query-client';
import { BrowserPage } from '@/pages/browser';
import { ChannelPage } from '@/pages/channel';
import { ChatPage } from '@/pages/chat';
import { CredentialPage } from '@/pages/credential';
import { KnowledgePage } from '@/pages/knowledge';
import { SchedulePage } from '@/pages/schedule';

const router = createBrowserRouter([
	{
		element: <AppLayout />,
		errorElement: <RouteError />,
		children: [
			{
				// Content-level boundary: a crash in a page replaces only
				// the Outlet area, so AppLayout (the icon rail / nav) stays
				// usable. The parent route keeps its own errorElement as a
				// last-resort catch-all for AppLayout/AppSidebar crashes.
				errorElement: <RouteError />,
				children: [
					{ path: '/', element: <Navigate to="/chat" replace /> },
					{
						path: '/chat/:agentId?/:sessionId?/:memberId?',
						element: <ChatPage />,
					},
					{ path: '/schedule', element: <SchedulePage /> },
					{ path: '/channel', element: <ChannelPage /> },
					{ path: '/credential', element: <CredentialPage /> },
					{ path: '/mcp', element: <MCPHubPage /> },
					{ path: '/mcp/:hubId', element: <MCPHubPage /> },
					{ path: '/skill', element: <SkillHubPage /> },
					{ path: '/skill/:hubId', element: <SkillHubPage /> },
					{ path: '/browser', element: <BrowserPage /> },
					{ path: '/knowledge', element: <KnowledgePage /> },
					{ path: '/knowledge/:kbId', element: <KnowledgePage /> },
				],
			},
		],
	},
]);

function App() {
	return (
		<QueryClientProvider client={queryClient}>
			{/* 全局窗口拖动带：覆盖登录、设置、错误与所有路由页面；仅占最上方 12px，
			    与页面交互控件互为兄弟节点，不会吞掉按钮、输入框或滚动事件。 */}
			<div aria-hidden="true" className="app-drag fixed inset-x-0 top-0 z-[200] h-3" />
			<RegionGate>
				<LoginGate>
					<UploadProvider>
						<RouterProvider router={router} />
					</UploadProvider>
				</LoginGate>
			</RegionGate>
			<Toaster richColors position="top-right" />
		</QueryClientProvider>
	);
}

export default App;
