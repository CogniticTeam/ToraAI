import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { workspaceApi } from '@/api';

interface ToraDataOptions {
	checkpoints?: boolean;
	diff?: boolean;
	hooks?: boolean;
}

/**
 * Tora 扩展数据。斜杠命令始终供输入框使用；其余数据仅在对应面板打开时读取，
	 * 避免每次进入聊天都执行 git diff、扫描检查点与读取钩子。
 */
export function useToraData(
	agentId: string | null,
	sessionId: string | null,
	cwd: string | null,
	options: ToraDataOptions = {},
) {
	const queryClient = useQueryClient();
	const { checkpoints = true, diff = true, hooks = true } = options;
	const hasSession = Boolean(sessionId);
	const checkpointsKey = ['tora', 'checkpoints', sessionId] as const;
	const diffKey = ['tora', 'diff', agentId, sessionId, cwd] as const;
	const hooksKey = ['tora', 'hooks', sessionId] as const;
	const commandsKey = ['tora', 'commands', sessionId] as const;

	const checkpointsQuery = useQuery({
		queryKey: checkpointsKey,
		queryFn: () => workspaceApi.tora.checkpoints(sessionId!),
		enabled: hasSession && checkpoints,
		retry: false,
	});
	const diffQuery = useQuery({
		queryKey: diffKey,
		queryFn: () => workspaceApi.tora.diff(agentId!, sessionId!),
		enabled: Boolean(agentId && sessionId && cwd && diff),
		retry: false,
	});
	const hooksQuery = useQuery({
		queryKey: hooksKey,
		queryFn: () => workspaceApi.tora.hooks(sessionId!),
		enabled: hasSession && hooks,
		retry: false,
	});
	const commandsQuery = useQuery({
		queryKey: commandsKey,
		queryFn: () => workspaceApi.tora.commands(sessionId!),
		enabled: hasSession,
		retry: false,
	});

	const refresh = useCallback(async () => {
		const pending: Promise<unknown>[] = [];
		if (hasSession) pending.push(commandsQuery.refetch());
		if (hasSession && checkpoints) pending.push(checkpointsQuery.refetch());
		if (agentId && sessionId && cwd && diff) pending.push(diffQuery.refetch());
		if (hasSession && hooks) pending.push(hooksQuery.refetch());
		await Promise.all(pending);
	}, [
		hasSession,
		agentId,
		sessionId,
		cwd,
		checkpoints,
		diff,
		hooks,
		commandsQuery.refetch,
		checkpointsQuery.refetch,
		diffQuery.refetch,
		hooksQuery.refetch,
	]);

	const restoreCheckpoint = useCallback(
		async (turn: number) => {
			if (!sessionId) return null;
			const result = await workspaceApi.tora.restoreCheckpoint(sessionId, turn);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: checkpointsKey }),
				queryClient.invalidateQueries({ queryKey: ['tora', 'diff', agentId, sessionId] }),
			]);
			return result;
		},
		[queryClient, agentId, sessionId],
	);

	const setProjectHooksTrusted = useCallback(
		async (targetCwd: string, trust: boolean) => {
			const result = await workspaceApi.tora.trustProjectHooks(targetCwd, trust);
			await queryClient.invalidateQueries({ queryKey: hooksKey });
			return result;
		},
		[queryClient, sessionId],
	);

	return {
		checkpoints: checkpointsQuery.data?.checkpoints ?? [],
		diff: diffQuery.data?.diff ?? '',
		diffError: diffQuery.data?.error ?? null,
		diffErrorCode: diffQuery.data?.error_code ?? null,
		hooks: hooksQuery.data ?? null,
		commands: commandsQuery.data ?? [],
		loading:
			(checkpoints && checkpointsQuery.isPending) ||
			(diff && diffQuery.isPending) ||
			(hooks && hooksQuery.isPending) ||
			(hasSession && commandsQuery.isPending),
		refresh,
		restoreCheckpoint,
		setProjectHooksTrusted,
	};
}
