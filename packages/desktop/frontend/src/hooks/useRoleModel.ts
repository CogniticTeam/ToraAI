import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatModelConfig } from '@/api';
import { isChatModelAvailable, type CredentialWithModels } from '@/hooks/useAvailableModels';
import { restoreUIState, useUICheckpoint } from '@/lib/uiCheckpoint';

interface Options {
	agentId: string | null;
	sessionId: string | null;
	sessionModel?: ChatModelConfig | null;
	defaultModel?: ChatModelConfig | null;
	groups: Record<string, CredentialWithModels[]>;
	modelsLoading: boolean;
	checkpointKey: string;
	draftKey?: string;
	pending?: boolean;
}

function readRememberedModel(key: string): ChatModelConfig | null {
	try {
		const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
		if (saved && typeof saved.type === 'string' && saved.type && typeof saved.credential_id === 'string' && typeof saved.model === 'string' && saved.model) {
			return { type: saved.type, credential_id: saved.credential_id, model: saved.model, parameters: {} };
		}
	} catch { /* A saved preference must never prevent startup. */ }
	return null;
}

export function useRoleModel({ agentId, sessionId, sessionModel, defaultModel, groups, modelsLoading, checkpointKey, draftKey = '', pending = false }: Options) {
	const scope = `${agentId ?? ''}:${draftKey}`;
	const preferenceKey = `tora-last-model:${checkpointKey}`;
	const [remembered, setRemembered] = useState(() => readRememberedModel(preferenceKey));
	const [draft, setDraft] = useState(() => ({
		scope,
		model: !sessionId && !pending ? restoreUIState<ChatModelConfig | null>(checkpointKey, null) : null,
	}));
	const created = useRef<{ scope: string; sessionId: string; model: ChatModelConfig | null } | null>(null);
	const explicitModel = draft.scope === scope ? draft.model : null;
	const handoff = created.current?.scope === scope && created.current.sessionId === sessionId ? created.current.model : null;
	const inheritedModel = remembered && (modelsLoading || isChatModelAvailable(groups, remembered)) ? remembered : defaultModel;
	const model = pending ? null : sessionId
		? (sessionModel !== undefined ? sessionModel : handoff)
		: (explicitModel ?? inheritedModel ?? null);

	useUICheckpoint(checkpointKey, !sessionId && !pending ? explicitModel : null);
	useEffect(() => {
		if (sessionModel !== undefined && created.current?.sessionId === sessionId) created.current = null;
	}, [sessionId, sessionModel]);

	const selectModel = useCallback((next: ChatModelConfig) => {
		const preference = { type: next.type, credential_id: next.credential_id, model: next.model };
		setRemembered({ ...preference, parameters: {} });
		setDraft({ scope, model: sessionId ? null : next });
		try { localStorage.setItem(preferenceKey, JSON.stringify(preference)); } catch { /* Storage failure must not block model selection. */ }
	}, [scope, sessionId, preferenceKey]);
	const sessionCreated = useCallback((id: string) => {
		created.current = { scope, sessionId: id, model };
		setDraft({ scope, model: null });
	}, [scope, model]);

	return { model, selectModel, sessionCreated };
}
