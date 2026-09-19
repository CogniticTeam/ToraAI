// 全局打开右侧面板的桥。
//
// 谁会用：Agent。桌面端主进程里跑的 Browser 工具需要「把浏览器面板打开」，
// 而它和 React 树之间只隔着 executeJavaScript —— 最省事的约定就是派发一个
// 自定义事件，由 ChatViewport 监听后把面板插进 dock 布局。
// 与 lib/openSettings.ts 同一套路：跨组件、跨进程，不靠 prop 层层传递。

import type { PanelKey } from '@/components/panel/PanelDock';

export const OPEN_PANEL_EVENT = 'cocode:open-panel';

/** 请求把某个右侧面板打开（已经打开时是 no-op）。 */
export function requestPanel(key: PanelKey) {
	window.dispatchEvent(new CustomEvent<PanelKey>(OPEN_PANEL_EVENT, { detail: key }));
}
