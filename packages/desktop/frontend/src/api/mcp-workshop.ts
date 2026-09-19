import { client } from './client';

export interface McpServerDef {
	name: string;
	command: string;
	args: string[];
	envKeys?: string[];
}

export interface McpTemplate {
	id: string;
	name: string;
	description: string;
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
	status: 'ok' | 'error';
	error?: string;
	stderrTail?: string | null;
	tools: McpTool[];
}

export const mcpWorkshopApi = {
	listServers: () => client.get<{ servers: McpServerDef[] }>('/mcp-workshop/servers', {}, { silent: true }),

	templates: () => client.get<{ templates: McpTemplate[] }>('/mcp-workshop/templates', {}, { silent: true }),

	addServer: (name: string, command: string, args: string[], env: Record<string, string>) =>
		client.post<McpServerDef>('/mcp-workshop/servers', { name, command, args, env }),

	updateServer: (name: string, patch: Partial<{ command: string; args: string[]; env: Record<string, string> }>) =>
		client.patch<McpServerDef>(`/mcp-workshop/servers/${name}`, patch),

	removeServer: (name: string) => client.delete<{ status: string }>(`/mcp-workshop/servers/${name}`),

	probe: (name: string) => client.post<McpProbeResult>(`/mcp-workshop/servers/${name}/probe`, {}),

	callTool: (name: string, tool: string, args: unknown) =>
		client.post<{ result: string }>(`/mcp-workshop/servers/${name}/call`, { tool, args }),
};
