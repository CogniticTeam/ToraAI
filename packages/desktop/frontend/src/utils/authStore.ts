/**
 * 凭证安全存储统一入口。
 * Electron 环境下 token/email/username 走主进程 safeStorage（Keychain 加密），
 * 浏览器/无桥环境降级到 localStorage。get 同步、set/del 异步——与原
 * localStorage 同步读、异步写的用法保持兼容，减少调用方改动。
 *
 * 安全收益：渲染层 XSS 也只能拿到 safeStorage 解密后的运行时副本（仍在
 * IPC 同步返回的字符串里），密文不在 DOM/storage 里明文暴露；主进程的
 * auth-storage.json 是 OS 加密的 blob。
 */

const LS_TOKEN = 'cocode_auth_token';
const LS_EMAIL = 'cocode_auth_email';
const LS_USERNAME = 'cocode_auth_username';

/** preload.cjs 通过 contextBridge 注入的凭证桥：get 同步、set/del 异步。 */
interface CocodeAuthBridge {
	getToken(): string | null;
	getEmail(): string | null;
	getUsername(): string | null;
	setToken(v: string): Promise<void>;
	setEmail(v: string): Promise<void>;
	setUsername(v: string): Promise<void>;
	delToken(): Promise<void>;
	delEmail(): Promise<void>;
	delUsername(): Promise<void>;
}

const bridge: CocodeAuthBridge | null =
	(typeof window !== 'undefined'
		? (window as unknown as { cocodeAuth?: CocodeAuthBridge }).cocodeAuth ?? null
		: null);

/** 凭证变化全局广播：LoginGate 监听，登出（delToken）立即切回全屏登录页 */
function emitAuthChanged() {
	if (typeof window !== 'undefined') window.dispatchEvent(new Event('cocode-auth-changed'));
}

/** 同步读 token（Electron 走 sendSync，浏览器走 localStorage） */
export function getToken(): string | null {
	if (bridge) return bridge.getToken();
	return localStorage.getItem(LS_TOKEN);
}
export function getEmail(): string | null {
	if (bridge) return bridge.getEmail();
	return localStorage.getItem(LS_EMAIL);
}
export function getUsername(): string | null {
	if (bridge) return bridge.getUsername();
	return localStorage.getItem(LS_USERNAME);
}

/** 异步写 token */
export async function setToken(v: string): Promise<void> {
	if (bridge) await bridge.setToken(v); else localStorage.setItem(LS_TOKEN, v);
	emitAuthChanged();
}
export async function setEmail(v: string): Promise<void> {
	if (bridge) return bridge.setEmail(v);
	localStorage.setItem(LS_EMAIL, v);
}
export async function setUsername(v: string): Promise<void> {
	if (bridge) return bridge.setUsername(v);
	localStorage.setItem(LS_USERNAME, v);
}

/** 异步清 token */
export async function delToken(): Promise<void> {
	if (bridge) await bridge.delToken(); else localStorage.removeItem(LS_TOKEN);
	emitAuthChanged();
}
export async function delEmail(): Promise<void> {
	if (bridge) return bridge.delEmail();
	localStorage.removeItem(LS_EMAIL);
}
export async function delUsername(): Promise<void> {
	if (bridge) return bridge.delUsername();
	localStorage.removeItem(LS_USERNAME);
}

/** 登出：清全部凭证 */
export async function clearAll(): Promise<void> {
	await Promise.all([delToken(), delEmail(), delUsername()]);
}
