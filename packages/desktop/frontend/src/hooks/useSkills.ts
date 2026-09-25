import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { skillApi } from '@/api';

/**
 * 用户级技能库。消息列表、输入框和技能面板会同时消费它，因此使用同一个
 * React Query 缓存来合并并发请求，并在安装/删除后统一失效。
 */
export function useSkills() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: ['skills'],
		queryFn: () => skillApi.list(),
	});
	const refetch = useCallback(async () => {
		const result = await query.refetch();
		return result.data ?? [];
	}, [query.refetch]);
	const remove = useCallback(
		async (skillId: string) => {
			await skillApi.remove(skillId);
			await queryClient.invalidateQueries({ queryKey: ['skills'] });
		},
		[queryClient],
	);

	return {
		skills: query.data ?? [],
		loading: query.isPending,
		error: query.error as Error | null,
		refetch,
		remove,
	};
}
