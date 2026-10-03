import { clearAll, getToken } from './authStore';
import { cloudApi } from './modelSync';

/** 主动退出：及时清理本地凭证，离线或服务异常也不会阻止退出。 */
export async function signOutAccount(): Promise<void> {
	const token = getToken();
	const revoke = token
		? fetch(`${cloudApi()}/auth/logout`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(5000),
		}).catch(() => {})
		: Promise.resolve();
	await clearAll();
	await revoke;
}
