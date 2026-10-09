// 全局打开设置窗口的桥：任意页面可调用 openSettings('model')，
// AppSidebar 监听同名 CustomEvent 后打开 SettingsDialog 并定位到指定板块。
// （设置窗口挂在 AppSidebar，跨组件不用 prop 层层传递。）

export const SETTINGS_SECTIONS = ['quota','account','general','theme','usage','agent','model','memory','data','about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Stale plugins and older links fall back to a usable page. */
export function normalizeSettingsSection(value: unknown): SettingsSection {
	return typeof value === 'string' && SETTINGS_SECTIONS.includes(value as SettingsSection) ? value as SettingsSection : 'general';
}

export const OPEN_SETTINGS_EVENT = 'tora:open-settings';

export function openSettings(section: SettingsSection = 'general') {
	window.dispatchEvent(new CustomEvent<SettingsSection>(OPEN_SETTINGS_EVENT, { detail: normalizeSettingsSection(section) }));
}
