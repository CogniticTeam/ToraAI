import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { workspaceApi } from '@/api';
import type { MCPClient, MCPClientStatus, Skill } from '@/api';
import type { UploadOptions } from '@/api/workspace';

interface WorkspaceQueryOptions {
	/** MCP 配置只在 MCP 面板打开时读取；技能列表始终供输入框使用。 */
	loadMcp?: boolean;
}

const EMPTY_MCPS: MCPClientStatus[] = [];
const EMPTY_SKILLS: Skill[] = [];

export function useWorkspace(
	agentId: string | null,
	sessionId: string | null,
	{ loadMcp = true }: WorkspaceQueryOptions = {},
) {
	const queryClient = useQueryClient();
	const mcpKey = useMemo(() => ['workspace', 'mcp', agentId, sessionId] as const, [agentId, sessionId]);
	const skillsKey = useMemo(() => ['workspace', 'skills', agentId, sessionId] as const, [agentId, sessionId]);
	const hasScope = Boolean(agentId && sessionId);

	const mcpQuery = useQuery<MCPClientStatus[]>({
		queryKey: mcpKey,
		queryFn: () => workspaceApi.mcp.list(agentId!, sessionId!),
		enabled: hasScope && loadMcp,
	});
	const skillsQuery = useQuery<Skill[]>({
		queryKey: skillsKey,
		queryFn: () => workspaceApi.skill.list(agentId!, sessionId!),
		enabled: hasScope,
	});

	// 空状态保持引用稳定，避免每次渲染都让 addMcps 等回调失效并级联重渲染。
	const mcps = mcpQuery.data ?? EMPTY_MCPS;
	const skills = skillsQuery.data ?? EMPTY_SKILLS;
	const refreshMcps = useCallback(
		() => queryClient.invalidateQueries({ queryKey: mcpKey }),
		[queryClient, mcpKey],
	);
	const refreshSkills = useCallback(
		() => queryClient.invalidateQueries({ queryKey: skillsKey }),
		[queryClient, skillsKey],
	);

	const addMcps = useCallback(
		async (clients: MCPClient[]) => {
			if (!agentId || !sessionId) throw new Error('No agent/session selected');
			const existingNames = new Set(mcps.map((m) => m.name));
			for (const mcp of clients) {
				if (existingNames.has(mcp.name)) {
					throw new Error(`MCP server "${mcp.name}" already exists in this workspace.`);
				}
			}
			const batchNames = new Set<string>();
			for (const mcp of clients) {
				if (batchNames.has(mcp.name)) {
					throw new Error(`Duplicate MCP server name "${mcp.name}" in configuration.`);
				}
				batchNames.add(mcp.name);
			}
			for (const mcp of clients) {
				await workspaceApi.mcp.add(agentId, sessionId, mcp);
			}
			await refreshMcps();
		},
		[agentId, sessionId, mcps, refreshMcps],
	);

	const addMcpsFromLibrary = useCallback(
		async (mcpIds: string[]) => {
			if (!agentId || !sessionId) throw new Error('No agent/session selected');
			const result = await workspaceApi.mcp.addFromLibrary(agentId, sessionId, mcpIds);
			await refreshMcps();
			const failures = Object.entries(result.failed);
			if (failures.length > 0) {
				throw new Error(failures.map(([name, why]) => `${name}: ${why}`).join('\n'));
			}
		},
		[agentId, sessionId, refreshMcps],
	);

	const removeMcp = useCallback(
		async (mcpName: string) => {
			if (!agentId || !sessionId) throw new Error('No agent/session selected');
			await workspaceApi.mcp.remove(mcpName, agentId, sessionId);
			await refreshMcps();
		},
		[agentId, sessionId, refreshMcps],
	);

	const uploadSkill = useCallback(
		async (files: File[], options: UploadOptions = {}) => {
			if (!agentId || !sessionId) throw new Error('No agent/session selected');
			await workspaceApi.skill.upload(agentId, sessionId, files, options);
			await refreshSkills();
		},
		[agentId, sessionId, refreshSkills],
	);

	const addSkillsFromLibrary = useCallback(
		async (skillIds: string[]) => {
			if (!agentId || !sessionId) throw new Error('No agent/session selected');
			const result = await workspaceApi.skill.addFromLibrary(agentId, sessionId, skillIds);
			await refreshSkills();
			const failures = Object.entries(result.failed);
			if (failures.length > 0) {
				throw new Error(failures.map(([name, why]) => `${name}: ${why}`).join('\n'));
			}
		},
		[agentId, sessionId, refreshSkills],
	);

	const removeSkill = useCallback(
		async (skillName: string) => {
			if (!agentId || !sessionId) throw new Error('No agent/session selected');
			await workspaceApi.skill.remove(skillName, agentId, sessionId);
			await refreshSkills();
		},
		[agentId, sessionId, refreshSkills],
	);

	return {
		mcps,
		loading: hasScope && loadMcp && mcpQuery.isPending,
		error: (mcpQuery.error ?? skillsQuery.error) as Error | null,
		refetch: mcpQuery.refetch,
		addMcps,
		addMcpsFromLibrary,
		removeMcp,
		skills,
		skillsLoading: hasScope && skillsQuery.isPending,
		uploadSkill,
		addSkillsFromLibrary,
		removeSkill,
	};
}
