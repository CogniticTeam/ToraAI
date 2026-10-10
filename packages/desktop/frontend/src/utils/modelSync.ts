// 模型列表的云端同步工具。
//
// 模型列表（设置→模型板块）以云端 auth-worker 为权威存储，一账号一列表、
// 跨设备同步；本地 config.modelList 只是运行时镜像（core 读它合成凭证）。
// 这里统一封装：
//   - cloudApi / cloudFetch：带 Bearer token 请求云端
//   - syncModelsFromCloud：登录后把云端列表全量写入本地镜像

import { getToken } from './authStore';

const AUTH_API_KEY = 'tora_auth_api';
const DEFAULT_AUTH_API = 'https://tora.ohfun.online';
const SERVER_URL_KEY = 'server_url';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:3210';
let mirrorWrites: Promise<unknown> = Promise.resolve();
let builtinWrites: Promise<unknown> = Promise.resolve();

export const cloudApi = () =>
	(localStorage.getItem(AUTH_API_KEY) || DEFAULT_AUTH_API).replace(/\/+$/, '');

const localApi = () =>
	(localStorage.getItem(SERVER_URL_KEY) || DEFAULT_SERVER_URL).replace(/\/+$/, '');

/** Sync account auth for built-in models in both modes; no upstream provider keys. */
export function syncBuiltinModelAuth(): Promise<void> {
	const token = getToken() || '', baseURL = cloudApi(), server = localApi();
	const write = builtinWrites.then(async () => {
		if (token !== (getToken() || '')) return;
		const response = await fetch(`${server}/admin/tochat-config`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ baseURL, authToken: token }), signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error('Built-in model auth update failed');
	});
	builtinWrites = write.catch(() => {});
	return write;
}

/** Account key stays in the local runtime; desktop quota uses Node transport. */
export async function fetchBuiltinQuota(signal?: AbortSignal): Promise<Response> {
	const token=getToken();
	await syncBuiltinModelAuth();
	if(token!==getToken())throw new Error('Account changed during quota read');
	const response=await fetch(`${localApi()}/admin/tochat-quota`,{signal:signal??AbortSignal.timeout(15000)});
	if(token!==getToken())throw new Error('Account changed during quota read');
	return response;
}

/** 带 Bearer token 的云端请求 */
export async function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${cloudApi()}${path}`, {
		...init,
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${getToken() ?? ''}`,
			...init?.headers,
		},
	});
}

/** Serialize mirror writes and discard responses belonging to a signed-out account. */
export function syncLocalModelMirror(models: unknown[], token: string): Promise<void> {
	const write = mirrorWrites.then(async () => {
		if (!token || getToken() !== token) return;
		const response = await fetch(`${localApi()}/admin/models-config`, {
			method: 'PUT', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ models }),
		});
		if (!response.ok) throw new Error('Model mirror update failed');
	});
	mirrorWrites = write.catch(() => {});
	return write;
}

/**
 * 拉取当前账号的自定义模型列表并写入本地运行时镜像。
 */
export async function syncModelsFromCloud(): Promise<void> {
	const token = getToken();
	if (!token) return;
	try {
		await syncBuiltinModelAuth();
		const res = await fetch(`${cloudApi()}/models`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!res.ok) return;
		const body = await res.json();
		if (getToken() !== token) return;
		const models = Array.isArray(body.models) ? body.models : [];
		await syncLocalModelMirror(models, token);
	} catch {
		// 同步失败不阻塞登录流程（下次打开设置板块会再拉一次）
	}
}


export async function verifyBuiltinHuman(proof:string):Promise<Response>{
 const account=getToken();await syncBuiltinModelAuth();
 if(account!==getToken())throw Error('Account changed during verification');
 const response=await fetch(`${localApi()}/admin/tochat-human-verification`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({'cf-turnstile-response':proof}),signal:AbortSignal.timeout(20000)});
 if(account!==getToken())throw Error('Account changed during verification');
 return response;
}
