// 模型列表的云端同步工具。
//
// 模型列表（设置→模型板块）以云端 auth-worker 为权威存储，一账号一列表、
// 跨设备同步；本地 config.modelList 只是运行时镜像（core 读它合成凭证）。
// 这里统一封装：
//   - cloudApi / cloudFetch：带 Bearer token 请求云端
//   - syncModelsFromCloud：登录后把云端列表全量写入本地镜像

import { getToken } from './authStore';

const AUTH_API_KEY = 'cocode_auth_api';
const DEFAULT_AUTH_API = 'https://cocode.ohfun.online';
const SERVER_URL_KEY = 'server_url';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:3210';

export const cloudApi = () =>
	(localStorage.getItem(AUTH_API_KEY) || DEFAULT_AUTH_API).replace(/\/+$/, '');

const localApi = () =>
	(localStorage.getItem(SERVER_URL_KEY) || DEFAULT_SERVER_URL).replace(/\/+$/, '');

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

/**
 * 拉取当前账号的自定义模型列表并写入本地运行时镜像。
 */
export async function syncModelsFromCloud(): Promise<void> {
	const token = getToken();
	if (!token) return;
	try {
		const res = await fetch(`${cloudApi()}/models`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!res.ok) return;
		const body = await res.json();
		const models = Array.isArray(body.models) ? body.models : [];
		await fetch(`${localApi()}/admin/models-config`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ models }),
		});
	} catch {
		// 同步失败不阻塞登录流程（下次打开设置板块会再拉一次）
	}
}
