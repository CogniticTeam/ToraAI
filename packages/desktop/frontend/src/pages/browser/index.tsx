import { BrowserPanel } from '@/components/panel/BrowserPanel';
import { getSearchEngineHomeUrl } from '@/lib/searchEngine';

/**
 * 全屏内置浏览器页：主内容区整体交给 BrowserPanel（标签栏 + 工具栏 + 页面区）。
 * webview 常驻在 body 下的宿主里（见 BrowserPanel 模块级标签管理），从聊天页
 * 切过来只是宿主重新对齐到本页占位区，页面状态不丢；与聊天页 dock 里的浏览器
 * 面板共享同一份标签管理器。
 */
export function BrowserPage() {
	const startUrl = getSearchEngineHomeUrl();

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 无边框窗口拖拽区：本页没有顶栏，顶部留一条空白把手。
			    不做进标签栏 —— 标签栏是 overflow-x-auto 滚动区，滚动区
			    当拖拽区在 Electron 里不可靠（见 AppSidebar 同款教训）。 */}
			<div className="app-drag h-8 shrink-0" />
			<div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
				<BrowserPanel initialUrl={startUrl} enableElementPicker={false} />
			</div>
		</div>
	);
}
