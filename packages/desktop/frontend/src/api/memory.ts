import { client } from './client';

/**
 * One long-term memory record (core 侧 `~/.vega/asapi/memories.json`，
 * 见 packages/core/src/asapi/memory.js）。跨会话注入 system 提示词，
 * 来源：AI 工具写入（tool）/ 自动提炼（distill）/ 手动创建（manual，API 强制）。
 */
export interface MemoryRecord {
	id: string;
	content: string;
	kind: 'preference' | 'fact' | 'pitfall' | 'convention';
	scope: 'global' | 'project';
	/** 归一化后的项目绝对路径；scope=global 时为空串 */
	project_key: string;
	source: string;
	pinned: boolean;
	created_at: string;
	updated_at: string;
}

export interface MemoryConfig {
	distill_enabled: boolean;
	inject_enabled: boolean;
}

export const memoryApi = {
	/** ?q= 走服务端评分检索；否则全量列表，可按 scope / project_key 过滤 */
	list: (params?: Record<string, string>) =>
		client.get<{ memories: MemoryRecord[]; total?: number }>('/memories', params),
	add: (body: { content: string; kind?: string; scope?: string; project_key?: string; pinned?: boolean }) =>
		client.post<{ status: string; memory: MemoryRecord; deduped: boolean }>('/memories', body),
	update: (id: string, patch: Partial<Pick<MemoryRecord, 'content' | 'kind' | 'scope' | 'project_key' | 'pinned'>>) =>
		client.patch<{ status: string; memory: MemoryRecord }>(`/memories/${id}`, patch),
	remove: (id: string) => client.delete<{ status: string }>(`/memories/${id}`),
	getConfig: () => client.get<MemoryConfig>('/memory-config'),
	saveConfig: (cfg: Partial<MemoryConfig>) => client.post<MemoryConfig>('/memory-config', cfg),
};
