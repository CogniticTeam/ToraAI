import { lazy, Suspense, useEffect } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';

import { RouteError } from '@/components/error/RouteError';
import { AppLayout } from '@/components/layout/AppLayout';
import { UploadProvider } from '@/context/UploadContext';
import { ChatPage } from '@/pages/chat';
import { installPollQueueSync } from '@/lib/pollQueue';

// 聊天是首屏，保留同步加载；其余独立工作台按路由再取，避免账号页、知识库、
// MCP/Skill 市场等重依赖阻塞一次对话的启动与输入。
const BrowserPage = lazy(async () => ({ default: (await import('@/pages/browser')).BrowserPage }));
const ChannelPage = lazy(async () => ({ default: (await import('@/pages/channel')).ChannelPage }));
const CredentialPage = lazy(async () => ({ default: (await import('@/pages/credential')).CredentialPage }));
const KnowledgePage = lazy(async () => ({ default: (await import('@/pages/knowledge')).KnowledgePage }));
const SchedulePage = lazy(async () => ({ default: (await import('@/pages/schedule')).SchedulePage }));
const MCPHubPage = lazy(async () => ({ default: (await import('./pages/mcp')).MCPHubPage }));
const SkillHubPage = lazy(async () => ({ default: (await import('./pages/skill')).SkillHubPage }));
const PollsPage = lazy(async () => ({ default: (await import('./pages/polls')).PollsPage }));

function PageLoading() {
	return <div className="grid h-full min-h-40 place-items-center text-sm text-muted-foreground" role="status">正在加载工作台…</div>;
}

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
					{ path: '/schedule', element: <Suspense fallback={<PageLoading />}><SchedulePage /></Suspense> },
					{ path: '/channel', element: <Suspense fallback={<PageLoading />}><ChannelPage /></Suspense> },
					{ path: '/credential', element: <Suspense fallback={<PageLoading />}><CredentialPage /></Suspense> },
					{ path: '/mcp', element: <Suspense fallback={<PageLoading />}><MCPHubPage /></Suspense> },
					{ path: '/mcp/:hubId', element: <Suspense fallback={<PageLoading />}><MCPHubPage /></Suspense> },
					{ path: '/skill', element: <Suspense fallback={<PageLoading />}><SkillHubPage /></Suspense> },
					{ path: '/skill/:hubId', element: <Suspense fallback={<PageLoading />}><SkillHubPage /></Suspense> },
					{ path: '/browser', element: <Suspense fallback={<PageLoading />}><BrowserPage /></Suspense> },
					{ path: '/polls', element: <Suspense fallback={<PageLoading />}><PollsPage /></Suspense> },
					{ path: '/knowledge', element: <Suspense fallback={<PageLoading />}><KnowledgePage /></Suspense> },
					{ path: '/knowledge/:kbId', element: <Suspense fallback={<PageLoading />}><KnowledgePage /></Suspense> },
				],
			},
		],
	},
]);

function Workspace() {
	useEffect(() => installPollQueueSync(), []);
	return (
		<UploadProvider>
			<RouterProvider router={router} />
		</UploadProvider>
	);
}

export default Workspace;
