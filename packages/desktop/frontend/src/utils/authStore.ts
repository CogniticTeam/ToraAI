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

const LS_TOKEN = 'tora_auth_token';
const LS_EMAIL = 'tora_auth_email';
const LS_USERNAME = 'tora_auth_username';
const LS_PROFILE = 'tora_auth_profile';

export interface AuthProfileRecord { token: string; email: string; username?: string | null }
export interface AuthCommitOperation { id: string; signal: AbortSignal; initialToken: string | null }
export interface AuthCommitReceipt { isCurrent(): boolean }
type LocalProfile = { token: string | null; email: string | null; username: string | null };

/** preload.cjs 通过 contextBridge 注入的凭证桥：get 同步、set/del 异步。 */
interface ToraAuthBridge {
	getToken(): string | null;
	getEmail(): string | null;
	getUsername(): string | null;
	setToken(v: string): Promise<void>;
	setEmail(v: string): Promise<void>;
	setUsername(v: string): Promise<void>;
	delToken(): Promise<void>;
	delEmail(): Promise<void>;
	delUsername(): Promise<void>;
	beginProfileCommit?(id: string, initialToken: string | null): number | null;
	cancelProfileCommit?(id: string, fence: number): boolean;
	commitProfile?(id: string, fence: number, profile: AuthProfileRecord): Promise<boolean>;
}

const bridge: ToraAuthBridge | null =
	(typeof window !== 'undefined'
		? (window as unknown as { toraAuth?: ToraAuthBridge }).toraAuth ?? null
		: null);

/** 凭证变化全局广播：LoginGate 监听，登出（delToken）立即切回全屏登录页 */
function emitAuthChanged() {
	if (typeof window !== 'undefined') window.dispatchEvent(new Event('tora-auth-changed'));
}

/** 浏览器也以一个记录为提交点；旧单字段存储只用于首次读取兼容。 */
function readLocalProfile(): LocalProfile | null {
	try {
		const value = JSON.parse(localStorage.getItem(LS_PROFILE) ?? 'null');
		if (!value || typeof value !== 'object') return null;
		return { token: typeof value.token === 'string' ? value.token : null, email: typeof value.email === 'string' ? value.email : null, username: typeof value.username === 'string' ? value.username : null };
	} catch { return null; }
}
function writeLocalValue(key: keyof LocalProfile, value: string | null) {
	const profile = readLocalProfile() ?? { token: localStorage.getItem(LS_TOKEN), email: localStorage.getItem(LS_EMAIL), username: localStorage.getItem(LS_USERNAME) };
	localStorage.setItem(LS_PROFILE, JSON.stringify({ ...profile, [key]: value }));
	localStorage.removeItem({ token: LS_TOKEN, email: LS_EMAIL, username: LS_USERNAME }[key]);
}

let activeProfileCommit: { id: string; fence: number | null } | null = null;
function cancelNativeCommit(commit: NonNullable<typeof activeProfileCommit>) {
	if (commit.fence === null) return;
	try { bridge?.cancelProfileCommit?.(commit.id, commit.fence); }
	catch { /* A closing window cannot acknowledge IPC; current-token CAS still protects later commits. */ }
}
function invalidateProfileCommit() {
	if (activeProfileCommit) cancelNativeCommit(activeProfileCommit);
	activeProfileCommit = null;
}
const canceled = () => new DOMException('Canceled', 'AbortError');

/** One fenced profile commit, never a chain of independent email/username/token writes. */
export async function commitAuthProfile(profile: AuthProfileRecord, operation: AuthCommitOperation): Promise<AuthCommitReceipt> {
	const record = { token: profile.token, email: profile.email, username: profile.username ?? '' };
	if (typeof record.token !== 'string' || !record.token || record.token.length > 4096 || typeof record.email !== 'string' || record.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email) || typeof record.username !== 'string' || record.username.length > 128) throw new Error('AUTH_PROFILE_INVALID');
	if (operation.signal.aborted || getToken() !== operation.initialToken) throw canceled();
	invalidateProfileCommit();
	const commit = { id: operation.id, fence: null as number | null };
	activeProfileCommit = commit;
	const abort = () => { cancelNativeCommit(commit); if (activeProfileCommit === commit) activeProfileCommit = null; };
	const isCurrent = () => !operation.signal.aborted && activeProfileCommit === commit && getToken() === record.token && getEmail() === record.email && (getUsername() ?? '') === record.username;
	operation.signal.addEventListener('abort', abort, { once: true });
	try {
		if (bridge) {
			// Older shells fail closed; falling back to individual IPC setters would reintroduce the race.
			if (!bridge.beginProfileCommit || !bridge.cancelProfileCommit || !bridge.commitProfile) throw new Error('AUTH_COMMIT_UNAVAILABLE');
			commit.fence = bridge.beginProfileCommit(commit.id, operation.initialToken);
			if (commit.fence === null || operation.signal.aborted) throw canceled();
			if (!await bridge.commitProfile(commit.id, commit.fence, record)) throw canceled();
		} else {
			if (operation.signal.aborted || activeProfileCommit !== commit || getToken() !== operation.initialToken) throw canceled();
			// Synchronous single-key write is the browser's linearization point.
			localStorage.setItem(LS_PROFILE, JSON.stringify(record));
		}
		if (!isCurrent()) throw canceled();
		emitAuthChanged();
		if (!isCurrent()) throw canceled();
		return { isCurrent };
	} catch (error) {
		abort();
		throw error;
	} finally { operation.signal.removeEventListener('abort', abort); }
}

/** 同步读 token（Electron 走 sendSync，浏览器走 localStorage） */
export function getToken(): string | null {
	if (bridge) return bridge.getToken();
	const profile = readLocalProfile();
	return profile ? profile.token : localStorage.getItem(LS_TOKEN);
}
export function getEmail(): string | null {
	if (bridge) return bridge.getEmail();
	const profile = readLocalProfile();
	return profile ? profile.email : localStorage.getItem(LS_EMAIL);
}
export function getUsername(): string | null {
	if (bridge) return bridge.getUsername();
	const profile = readLocalProfile();
	return profile ? profile.username : localStorage.getItem(LS_USERNAME);
}

/** 异步写 token */
export async function setToken(v: string): Promise<void> {
	invalidateProfileCommit();
	if (bridge) await bridge.setToken(v); else writeLocalValue('token', v);
	emitAuthChanged();
}
export async function setEmail(v: string): Promise<void> {
	invalidateProfileCommit();
	if (bridge) return bridge.setEmail(v);
	writeLocalValue('email', v);
}
export async function setUsername(v: string): Promise<void> {
	invalidateProfileCommit();
	if (bridge) return bridge.setUsername(v);
	writeLocalValue('username', v);
}

/** 异步清 token */
export async function delToken(): Promise<void> {
	invalidateProfileCommit();
	if (bridge) await bridge.delToken(); else writeLocalValue('token', null);
	emitAuthChanged();
}
export async function delEmail(): Promise<void> {
	invalidateProfileCommit();
	if (bridge) return bridge.delEmail();
	writeLocalValue('email', null);
}
export async function delUsername(): Promise<void> {
	invalidateProfileCommit();
	if (bridge) return bridge.delUsername();
	writeLocalValue('username', null);
}

/** 登出：清全部凭证 */
export async function clearAll(): Promise<void> {
	await Promise.all([delToken(), delEmail(), delUsername()]);
}
