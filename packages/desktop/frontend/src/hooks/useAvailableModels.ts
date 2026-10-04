import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { credentialApi, modelApi } from '@/api';
import type { CredentialView, ModelCard } from '@/api';
import { queryClient } from '@/lib/query-client';
import { TOCHAT_MODELS, isBuiltinCredential, modelAvailable, type BuiltinQuota } from '@/lib/tochatModels';
import { cloudFetch, syncBuiltinModelAuth } from '@/utils/modelSync';

export interface CredentialWithModels {
	credential: CredentialView;
	models: ModelCard[];
	quota?: BuiltinQuota;
	unavailable?: boolean;
}

/**
 * Fetches all credentials and their available models, grouped by provider type.
 * Provider type is read from `credential.data.type`.
 * Credentials without a `type` field or whose model fetch fails are silently skipped.
 *
 * One credential list plus one model list per provider — the most expensive
 * fan-out on the page, and every model picker in the app mounts it. Cached
 * under the shared default window and re-fetched on demand through
 * `refetch`, which is what the "credential just added" trigger calls.
 */
async function fetchGroups(): Promise<Record<string, CredentialWithModels[]>> {
	await syncBuiltinModelAuth().catch(() => {});
	const { credentials } = await credentialApi.list();
	const result: Record<string, CredentialWithModels[]> = {};

	await Promise.all(
		credentials.map(async (credential) => {
			const type = credential.data.type as string | undefined;
			if (!type) return;
			if (!result[type]) result[type] = [];
			try {
				const { models } = await modelApi.list(type);
				let quota: BuiltinQuota | undefined;
				if (isBuiltinCredential(credential.id)) {
					const response = await cloudFetch('/tochat/quota', { signal: AbortSignal.timeout(10000) });
					if (!response.ok) throw new Error('Built-in models unavailable');
					quota = await response.json() as BuiltinQuota;
				}
				// Reverse-alphabetical, which is how the providers' naming
				// schemes rank themselves — gpt-5 before gpt-4, qwen3 before
				// qwen2 — so the strongest models sit at the top of the picker.
				result[type].push({
					credential,
					quota,
					models: models.filter(model => !quota || (quota.enabled && modelAvailable(model.name, quota.models))).sort((a, b) =>
						isBuiltinCredential(credential.id) ? TOCHAT_MODELS.findIndex(model => model.id === a.name) - TOCHAT_MODELS.findIndex(model => model.id === b.name) : b.name.localeCompare(a.name, undefined, { numeric: true }),
					),
				});
			} catch {
				result[type].push({ credential, models: [], unavailable: true });
			}
		}),
	);

	return result;
}

/**
 * Cache key for the grouped model list. Exported so a credential change —
 * which moves what these groups contain — can invalidate it.
 */
export const AVAILABLE_MODELS_KEY = ['available-models'];

export function useAvailableModels(live = false) {
	const { data, isPending, error, refetch } = useQuery({
		queryKey: AVAILABLE_MODELS_KEY,
		queryFn: fetchGroups,
	});
	useEffect(() => {
		const changed = () => { void queryClient.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY }); void queryClient.invalidateQueries({queryKey:['builtin-quota']}); };
		window.addEventListener('tora-auth-changed', changed);
		window.addEventListener('tora-subscription-changed', changed);
		return () => {window.removeEventListener('tora-auth-changed', changed);window.removeEventListener('tora-subscription-changed', changed);};
	}, []);
	const refresh = useCallback(() => { void refetch(); }, [refetch]);
	const builtin = Object.values(data ?? {}).flat().find(item => isBuiltinCredential(item.credential.id));
	const liveQuota=useQuery({queryKey:['builtin-quota'],enabled:!!builtin,refetchInterval:live?2000:30000,queryFn:async()=>{const response=await cloudFetch('/tochat/quota',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Built-in models unavailable');return await response.json() as BuiltinQuota;}});

	return {
		groups: data ?? {},
		loading: isPending,
		error: error as Error | null,
		refetch: refresh,
		builtinQuota: liveQuota.data ?? builtin?.quota,
		builtinUnavailable: liveQuota.isError || (builtin?.unavailable ?? false),
	};
}
