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
 * 官方条目 apiKey 在云端恒为空（真实上游密钥只保存在 Worker），写本地镜像前
 * 必须统一用登录 token 填充：core 拿它请求 /official/v1 网关，网关鉴权后
 * 注入真实 Key 并按用量扣积分。所有往本地镜像写官方模型的路径都要过这里，
 * 否则 core 合成凭证时 apiKey 为空，会报「未配置 apiKey」。
 */
export function withOfficialToken<T extends { isOfficial?: boolean; apiKey?: string }>(
	models: T[],
): T[] {
	const token = getToken();
	if (!token) return models;
	return models.map((m) => (m && m.isOfficial ? { ...m, apiKey: token } : m));
}

/**
 * 确保云端已为当前账号发放官方模型行（幂等），再全量拉取模型列表
 * （含官方）写入本地镜像。官方条目的 apiKey 由 withOfficialToken 统一填充。
 */
export async function syncModelsFromCloud(): Promise<void> {
	const token = getToken();
	if (!token) return;
	try {
		// 1) 幂等发放官方模型（云端目录，含免费/基础/标准/高级/旗舰五档），失败不阻塞
		//    ——下面的 includeOfficial 仍会返回已发放过的行。
		await fetch(`${cloudApi()}/official/models`, {
			headers: { authorization: `Bearer ${token}` },
		}).catch(() => undefined);

		// 2) 拉全量列表（含官方），官方条目用登录 token 填 apiKey
		const res = await fetch(`${cloudApi()}/models?includeOfficial=1`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!res.ok) return;
		const body = await res.json();
		const models = withOfficialToken(Array.isArray(body.models) ? body.models : []);
		await fetch(`${localApi()}/admin/models-config`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ models }),
		});
	} catch {
		// 同步失败不阻塞登录流程（下次打开设置板块会再拉一次）
	}
}
