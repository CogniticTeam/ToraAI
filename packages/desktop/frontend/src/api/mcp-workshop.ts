import { client } from './client';

export interface McpApplication {
	name: string;
	description: string;
	website: string;
}

export interface McpServerDef {
	name: string;
	command: string;
	args: string[];
	envKeys?: string[];
	url?: string;
	headerKeys?: string[];
	provider?: 'github';
	enabled: boolean;
	application: McpApplication | null;
}

export interface McpTemplate {
	id: string;
	name: string;
	description: string;
	url?: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

export interface McpTool {
	name: string;
	description?: string;
}

export interface McpProbeResult {
	name: string;
	command: string;
	args: string[];
	status: 'ok' | 'error' | 'disabled';
	error?: string;
	stderrTail?: string | null;
	tools: McpTool[];
}

export const mcpWorkshopApi = {
	listServers: () => client.get<{ servers: McpServerDef[] }>('/mcp-workshop/servers', {}, { silent: true }),

	templates: () => client.get<{ templates: McpTemplate[] }>('/mcp-workshop/templates', {}, { silent: true }),

	addServer: (name: string, command: string, args: string[], env: Record<string, string>, options?: { enabled?: boolean; application?: McpApplication }) =>
		client.post<McpServerDef>('/mcp-workshop/servers', { name, command, args, env, ...options }),
	addRemoteServer: (name: string, url: string, headers: Record<string, string>, application?: McpApplication) =>
		client.post<McpServerDef>('/mcp-workshop/servers', { name, url, headers, application, enabled: false }),
	importServers: (content: string) => client.post<{ servers: McpServerDef[] }>('/mcp-workshop/import', { content }),

	updateServer: (name: string, patch: Partial<{ command: string; args: string[]; env: Record<string, string>; envPatch: Record<string, string>; url: string; headerPatch: Record<string, string>; enabled: boolean; application: McpApplication | null }>) =>
		client.patch<McpServerDef>(`/mcp-workshop/servers/${name}`, patch),

	removeServer: (name: string) => client.delete<{ status: string }>(`/mcp-workshop/servers/${name}`),

	probe: async (name: string): Promise<McpProbeResult> => {
		const result = await client.post<Omit<McpProbeResult, 'tools'> & { tools: (string | McpTool)[] }>(`/mcp-workshop/servers/${name}/probe`, {});
		return { ...result, tools: result.tools.map(tool => typeof tool === 'string' ? { name: tool } : tool) };
	},

	callTool: (name: string, tool: string, args: unknown) =>
		client.post<{ result: string }>(`/mcp-workshop/servers/${name}/call`, { tool, args }),
};
