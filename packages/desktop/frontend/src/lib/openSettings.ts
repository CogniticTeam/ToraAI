// 全局打开设置窗口的桥：任意页面可调用 openSettings('model')，
// AppSidebar 监听同名 CustomEvent 后打开 SettingsDialog 并定位到指定板块。
// （设置窗口挂在 AppSidebar，跨组件不用 prop 层层传递。）

export type SettingsSection = 'general' | 'theme' | 'agent' | 'model' | 'memory' | 'data' | 'about' | 'developer';

export const OPEN_SETTINGS_EVENT = 'cocode:open-settings';

export function openSettings(section: SettingsSection = 'general') {
	window.dispatchEvent(new CustomEvent<SettingsSection>(OPEN_SETTINGS_EVENT, { detail: section }));
}
