import { client } from './client';

export const CODEX_PROVIDER = 'codex_subscription';
export const CODEX_CREDENTIAL_ID = 'tora-codex';
export interface CodexModelSelection { model: string; enabled: boolean }
export interface CodexModelItem extends CodexModelSelection {
  id: string; provider: string; label: string; baseURL: string; apiKeySet: boolean; localOnly: true;
}
export interface CodexStatus {
  connected: boolean; needsReauth: boolean; storage: 'encrypted' | 'memory'; email: string; models: CodexModelItem[];
}
export interface CodexCatalogModel { id: string; name: string; context: number; maxOutput: number; vision: boolean; efforts: string[] }
export interface CodexFlow { flowId: string; userCode: string; verificationUrl: string; expiresAt: number; interval: number }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await client.stream(`/admin/codex/${path}`, { method, body, silent: true, timeoutMs: 35000 });
  return response.json() as Promise<T>;
}
export const codexApi = {
  status: () => request<CodexStatus>('status'),
  models: () => request<{ models: CodexCatalogModel[]; selected: CodexModelSelection[] }>('models'),
  saveModels: (models: CodexModelSelection[]) => request<CodexStatus>('models', 'PUT', { models }),
  start: () => request<CodexFlow>('device-flow/start', 'POST', {}),
  poll: (flowId: string) => request<{ status: 'pending' | 'connected'; interval?: number }>('device-flow/poll', 'POST', { flowId }),
  cancel: (flowId: string) => request('device-flow/cancel', 'POST', { flowId }),
  disconnect: () => request<CodexStatus>('connection', 'DELETE'),
};
