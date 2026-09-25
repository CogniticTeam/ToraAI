import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { agentApi } from '../api';
import type { CreateAgentRequest, UpdateAgentRequest } from '../api';

/**
 * Manages the full agent list with CRUD operations.
 * Fetches on mount and automatically re-fetches after each mutation.
 */
export function useAgents() {
	const queryClient = useQueryClient();
	const { data, isPending, error, refetch: runRefetch } = useQuery({
		queryKey: ['agents'],
		queryFn: () => agentApi.list().then((res) => res.agents),
	});
	const agents = data ?? [];
	const refetch = useCallback(async () => {
		const result = await runRefetch();
		return result.data ?? [];
	}, [runRefetch]);
	const refresh = useCallback(
		() => queryClient.invalidateQueries({ queryKey: ['agents'] }),
		[queryClient],
	);

	/** Creates a new agent and refreshes the list. */
	const create = useCallback(
		async (body: CreateAgentRequest, options?: { silent?: boolean }) => {
			const res = await agentApi.create(body, options);
			await refresh();
			return res;
		},
		[refresh],
	);

	/** Partially updates an agent and refreshes the list. */
	const update = useCallback(
		async (agentId: string, body: UpdateAgentRequest, options?: { silent?: boolean }) => {
			const res = await agentApi.update(agentId, body, options);
			await refresh();
			return res;
		},
		[refresh],
	);

	/** Deletes an agent and refreshes the list. */
	const remove = useCallback(
		async (agentId: string) => {
			await agentApi.delete(agentId);
			await refresh();
		},
		[refresh],
	);

	return { agents, loading: isPending, error: error as Error | null, refetch, create, update, remove };
}
