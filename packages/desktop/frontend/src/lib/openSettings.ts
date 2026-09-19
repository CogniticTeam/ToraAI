// 全局打开设置窗口的桥：任意页面可调用 openSettings('model')，
// AppSidebar 监听同名 CustomEvent 后打开 SettingsDialog 并定位到指定板块。
// （设置窗口挂在 AppSidebar，跨组件不用 prop 层层传递。）

export type SettingsSection = 'general' | 'agent' | 'model' | 'memory' | 'data' | 'about' | 'developer';

export const OPEN_SETTINGS_EVENT = 'cocode:open-settings';

export function openSettings(section: SettingsSection = 'general') {
	window.dispatchEvent(new CustomEvent<SettingsSection>(OPEN_SETTINGS_EVENT, { detail: section }));
}

// 全局打开订阅窗口：账户页积分卡片「查看套餐 / 去兑换」用它唤起
// AppSidebar 挂载的 SubscriptionDialog。
export const OPEN_SUBSCRIPTION_EVENT = 'cocode:open-subscription';

export function openSubscription() {
	window.dispatchEvent(new CustomEvent(OPEN_SUBSCRIPTION_EVENT));
}
