import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { workspaceApi } from '@/api';

interface CocodeDataOptions {
	checkpoints?: boolean;
	diff?: boolean;
	hooks?: boolean;
	traces?: boolean;
}

/**
 * CoCode 扩展数据。斜杠命令始终供输入框使用；其余数据仅在对应面板打开时读取，
 * 避免每次进入聊天都执行 git diff、扫描检查点与读取轨迹文件。
 */
export function useCocodeData(
	agentId: string | null,
	sessionId: string | null,
	cwd: string | null,
	options: CocodeDataOptions = {},
) {
	const queryClient = useQueryClient();
	const { checkpoints = true, diff = true, hooks = true, traces = true } = options;
	const hasSession = Boolean(sessionId);
	const checkpointsKey = ['cocode', 'checkpoints', sessionId] as const;
	const diffKey = ['cocode', 'diff', agentId, sessionId, cwd] as const;
	const hooksKey = ['cocode', 'hooks', sessionId] as const;
	const commandsKey = ['cocode', 'commands', sessionId] as const;
	const tracesKey = ['cocode', 'traces', sessionId] as const;

	const checkpointsQuery = useQuery({
		queryKey: checkpointsKey,
		queryFn: () => workspaceApi.cocode.checkpoints(sessionId!),
		enabled: hasSession && checkpoints,
		retry: false,
	});
	const diffQuery = useQuery({
		queryKey: diffKey,
		queryFn: () => workspaceApi.cocode.diff(agentId!, sessionId!),
		enabled: Boolean(agentId && sessionId && cwd && diff),
		retry: false,
	});
	const hooksQuery = useQuery({
		queryKey: hooksKey,
		queryFn: () => workspaceApi.cocode.hooks(sessionId!),
		enabled: hasSession && hooks,
		retry: false,
	});
	const commandsQuery = useQuery({
		queryKey: commandsKey,
		queryFn: () => workspaceApi.cocode.commands(sessionId!),
		enabled: hasSession,
		retry: false,
	});
	const tracesQuery = useQuery({
		queryKey: tracesKey,
		queryFn: () => workspaceApi.cocode.traces(sessionId!),
		enabled: hasSession && traces,
		retry: false,
	});

	const refresh = useCallback(async () => {
		const pending: Promise<unknown>[] = [];
		if (hasSession) pending.push(commandsQuery.refetch());
		if (hasSession && checkpoints) pending.push(checkpointsQuery.refetch());
		if (agentId && sessionId && cwd && diff) pending.push(diffQuery.refetch());
		if (hasSession && hooks) pending.push(hooksQuery.refetch());
		if (hasSession && traces) pending.push(tracesQuery.refetch());
		await Promise.all(pending);
	}, [
		hasSession,
		agentId,
		sessionId,
		cwd,
		checkpoints,
		diff,
		hooks,
		traces,
		commandsQuery.refetch,
		checkpointsQuery.refetch,
		diffQuery.refetch,
		hooksQuery.refetch,
		tracesQuery.refetch,
	]);

	const restoreCheckpoint = useCallback(
		async (turn: number) => {
			if (!sessionId) return null;
			const result = await workspaceApi.cocode.restoreCheckpoint(sessionId, turn);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: checkpointsKey }),
				queryClient.invalidateQueries({ queryKey: ['cocode', 'diff', agentId, sessionId] }),
			]);
			return result;
		},
		[queryClient, agentId, sessionId],
	);

	const setProjectHooksTrusted = useCallback(
		async (targetCwd: string, trust: boolean) => {
			const result = await workspaceApi.cocode.trustProjectHooks(targetCwd, trust);
			await queryClient.invalidateQueries({ queryKey: hooksKey });
			return result;
		},
		[queryClient, sessionId],
	);

	const openTrace = useCallback(async (id: string) => {
		const result = await workspaceApi.cocode.traceMarkdown(id);
		return result.markdown;
	}, []);

	return {
		checkpoints: checkpointsQuery.data?.checkpoints ?? [],
		diff: diffQuery.data?.diff ?? '',
		diffError: diffQuery.data?.error ?? null,
		hooks: hooksQuery.data ?? null,
		commands: commandsQuery.data ?? [],
		traces: tracesQuery.data?.traces ?? [],
		loading:
			(checkpoints && checkpointsQuery.isPending) ||
			(diff && diffQuery.isPending) ||
			(hooks && hooksQuery.isPending) ||
			(hasSession && commandsQuery.isPending) ||
			(traces && tracesQuery.isPending),
		refresh,
		restoreCheckpoint,
		setProjectHooksTrusted,
		openTrace,
	};
}
