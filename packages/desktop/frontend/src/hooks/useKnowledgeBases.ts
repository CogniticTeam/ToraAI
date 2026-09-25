import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { knowledgeBaseApi } from '@/api';
import type {
	CreateKnowledgeBaseRequest,
	KnowledgeBaseView,
	SearchKnowledgeBaseRequest,
	UpdateKnowledgeBaseRequest,
} from '@/api';

/**
 * Knowledge base CRUD + search wrapper.
 *
 * Loads the caller's knowledge bases from `/knowledge_bases/` on mount
 * and refetches after every mutation, so the UI stays consistent with
 * the server-side state.
 */
export function useKnowledgeBases({ enabled = true }: { enabled?: boolean } = {}) {
	const queryClient = useQueryClient();
	const [creating, setCreating] = useState(false);
	const { data, isPending, error, refetch: runRefetch } = useQuery({
		queryKey: ['knowledge-bases'],
		queryFn: () => knowledgeBaseApi.listAll(),
		enabled,
	});
	const knowledgeBases = data ?? [];
	const refetch = useCallback(async () => {
		const result = await runRefetch();
		return result.data ?? [];
	}, [runRefetch]);
	const refresh = useCallback(
		() => queryClient.invalidateQueries({ queryKey: ['knowledge-bases'] }),
		[queryClient],
	);

	/** Create a new knowledge base and refresh the list. */
	const create = useCallback(
		async (body: CreateKnowledgeBaseRequest): Promise<string> => {
			setCreating(true);
		try {
			const { knowledge_base_id } = await knowledgeBaseApi.create(body);
			await refresh();
			return knowledge_base_id;
		} finally {
				setCreating(false);
			}
		},
		[refresh],
	);

	/** Permanently delete a knowledge base and refresh the list. */
	const remove = useCallback(
		async (knowledgeBaseId: string) => {
			await knowledgeBaseApi.delete(knowledgeBaseId);
			await refresh();
		},
		[refresh],
	);

	/** Update mutable fields on a knowledge base and refresh the list. */
	const update = useCallback(
		async (
			knowledgeBaseId: string,
			body: UpdateKnowledgeBaseRequest,
		): Promise<KnowledgeBaseView> => {
			const view = await knowledgeBaseApi.update(knowledgeBaseId, body);
			await refresh();
			return view;
		},
		[refresh],
	);

	/** Upload a document into a knowledge base. */
	const uploadDocument = useCallback(
		(knowledgeBaseId: string, file: File) =>
			knowledgeBaseApi.uploadDocument(knowledgeBaseId, file),
		[],
	);

	/** Delete a document from a knowledge base. */
	const deleteDocument = useCallback(
		(knowledgeBaseId: string, documentId: string) =>
			knowledgeBaseApi.deleteDocument(knowledgeBaseId, documentId),
		[],
	);

	/** Search a knowledge base by natural-language query. */
	const search = useCallback(
		(knowledgeBaseId: string, body: SearchKnowledgeBaseRequest) =>
			knowledgeBaseApi.search(knowledgeBaseId, body),
		[],
	);

	return {
		knowledgeBases,
		loading: enabled && isPending,
		creating,
		error: error as Error | null,
		refetch,
		create,
		remove,
		update,
		uploadDocument,
		deleteDocument,
		search,
	};
}
