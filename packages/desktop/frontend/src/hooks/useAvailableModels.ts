import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { credentialApi, modelApi } from '@/api';
import type { CredentialView, ModelCard } from '@/api';
import { queryClient } from '@/lib/query-client';
import { TOCHAT_MODELS, isBuiltinCredential, type BuiltinQuota, type ToChatModelAvailability } from '@/lib/tochatModels';
import { fetchBuiltinQuota, syncBuiltinModelAuth } from '@/utils/modelSync';

export interface CredentialWithModels {
	credential: CredentialView;
	models: ModelCard[];
	quota?: BuiltinQuota;
	unavailable?: boolean;
}

export function quotaModelCards(models:ToChatModelAvailability[]):ModelCard[]{
 return models.filter(model=>model.enabled).map(model=>({type:'chat_model',name:model.id,label:model.name||model.id,status:'active',deprecated_at:null,input_types:(model.input_modalities||['text','image']).flatMap(type=>type==='image'?['image/jpeg','image/png','image/webp','image/gif']:type==='audio'?['audio/mpeg','audio/wav','audio/flac','audio/aac','audio/mp4']:type==='video'?['video/mp4','video/quicktime']:['text']),output_types:['text'],context_size:model.context||128000,output_size:model.maxOutput||16384,parameter_schema:{type:'object',properties:{}},parameters_overrides:{}}));
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
	await syncBuiltinModelAuth();
	const { credentials } = await credentialApi.list();
	const result: Record<string, CredentialWithModels[]> = {};

	await Promise.all(
		credentials.map(async (credential) => {
			const type = credential.data.type as string | undefined;
			if (!type) return;
			if (!result[type]) result[type] = [];
			let models: ModelCard[] = [];
			try {
				models = (await modelApi.list(type)).models;
				let quota: BuiltinQuota | undefined;
				if (isBuiltinCredential(credential.id)) {
					const response = await fetchBuiltinQuota(AbortSignal.timeout(15000));
					if (!response.ok) throw new Error('Built-in models unavailable');
					quota = await response.json() as BuiltinQuota;
					if(quota.catalogRevision!==undefined && quota.models)models=quotaModelCards(quota.models);
				}
				// Reverse-alphabetical, which is how the providers' naming
				// schemes rank themselves — gpt-5 before gpt-4, qwen3 before
				// qwen2 — so the strongest models sit at the top of the picker.
				result[type].push({
					credential,
					quota,
					models: models.sort((a, b) =>
						isBuiltinCredential(credential.id) ? TOCHAT_MODELS.findIndex(model => model.id === a.name) - TOCHAT_MODELS.findIndex(model => model.id === b.name) : b.name.localeCompare(a.name, undefined, { numeric: true }),
					),
				});
			} catch {
				result[type].push({ credential, models: isBuiltinCredential(credential.id) ? models : [], unavailable: true });
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

/** Catalog survives connection errors; live availability controls selection. */
export function modelGroupsWithQuota(groups: Record<string, CredentialWithModels[]>, quota: BuiltinQuota | undefined, unavailable: boolean) {
	return Object.fromEntries(Object.entries(groups).map(([type,items]) => [type,items.map(item => !isBuiltinCredential(item.credential.id) ? item : {
		...item,quota,unavailable,
		credential:quota?.models?{...item.credential,data:{...item.credential.data,model_providers:Object.fromEntries(quota.models.map(model=>[model.id,model.provider]))}}:item.credential,
		models:quota?.catalogRevision!==undefined&&quota.models?quotaModelCards(quota.models):item.models.filter(model=>unavailable||!quota?.models||quota.models.some(info=>info.id===model.name&&info.enabled)).sort((a,b)=>TOCHAT_MODELS.findIndex(model=>model.id===a.name)-TOCHAT_MODELS.findIndex(model=>model.id===b.name)),
	})]));
}

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
	const builtin = Object.values(data ?? {}).flat().find(item => isBuiltinCredential(item.credential.id));
	const liveQuota=useQuery({queryKey:['builtin-quota'],enabled:!!builtin,refetchInterval:live?2000:30000,queryFn:async()=>{const response=await fetchBuiltinQuota(AbortSignal.timeout(15000));if(!response.ok)throw Error('Built-in models unavailable');return await response.json() as BuiltinQuota;}});
	const quota = liveQuota.data ?? builtin?.quota;
	const unavailable = !!builtin && (!!error || liveQuota.isError || !quota?.enabled || (!liveQuota.data && !!builtin.unavailable));
	const groups = useMemo(()=>modelGroupsWithQuota(data ?? {},quota,unavailable),[data,quota,unavailable]);
	const hasBuiltin = !!builtin, refetchQuota = liveQuota.refetch;
	const refresh = useCallback(() => { void refetch(); if(hasBuiltin) void refetchQuota(); }, [refetch,hasBuiltin,refetchQuota]);

	return {
		groups,
		loading: isPending,
		error: error as Error | null,
		refetch: refresh,
		builtinQuota: quota,
		builtinUnavailable: unavailable,
	};
}
