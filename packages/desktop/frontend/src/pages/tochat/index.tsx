import { motion } from 'framer-motion';
import { ChevronDown, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { sessionApi, type ChatModelConfig, type ContentBlock, type UpdateSessionRequest } from '@/api';
import {AgentQuotaMeter} from '@/components/chat/AgentQuotaMeter';
import { ChatContent } from '@/components/chat/ChatContent';
import { QuestionPanel } from '@/components/chat/QuestionPanel';
import { WindowDragRegion } from '@/components/layout/WindowDragRegion';
import { LlmSelect } from '@/components/select/LlmSelect';
import {OfficialModelSelect} from '@/components/select/OfficialModelSelect';
import { PermissionModeSelect } from '@/components/select/PermissionModeSelect';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { AudioProvider } from '@/context/AudioContext';
import { useAgents } from '@/hooks/useAgents';
import { useMessages } from '@/hooks/useMessages';
import { useMotionSettings } from '@/hooks/useMotionSettings';
import { useSessions } from '@/hooks/useSessions';
import { useTranslation } from '@/i18n/useI18n';
import { modeCopy, readToChatSource, TOCHAT_SOURCE_EVENT, type ToChatTask } from '@/lib/applicationModes';
import {chatAttachmentTypes, processChatAttachment} from '@/lib/chatAttachments';
import { openSettings } from '@/lib/openSettings';
import { modelAllowedInMode, modelAvailable, toChatEffort, toChatModel, type ToChatModelId, type BuiltinQuota } from '@/lib/tochatModels';
import { getToken } from '@/utils/authStore';
import { fetchBuiltinQuota, syncBuiltinModelAuth } from '@/utils/modelSync';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Quota = BuiltinQuota;
const TAB_TRANSITIONS = {
	off: { duration: 0 },
	gentle: { type: 'spring' as const, stiffness: 250, damping: 30, mass: 0.7 },
	standard: { type: 'spring' as const, stiffness: 380, damping: 30, mass: 0.6 },
	fast: { type: 'spring' as const, stiffness: 620, damping: 42, mass: 0.5 },
};

/** Reuses the existing message stream and composer; no new CSS or layout skin. */
function ToChatConversation() {
	const navigate = useNavigate();
	const { agentId: urlAgent, sessionId } = useParams();
	const [params] = useSearchParams();
	const { agents } = useAgents();
	const agentId = urlAgent || agents[0]?.id || null;
	const { sessions, loading: sessionsLoading, refetch } = useSessions(agentId);
	const view = sessions.find((item) => item.session.id === sessionId);
	const { i18n, t } = useTranslation();
	const copy = modeCopy(i18n.language);
	const { effective, clickEnabled } = useMotionSettings();
	const tabMotion = clickEnabled ? effective : 'off';
	const task: ToChatTask = view?.session.config.task_mode ?? (params.get('task') === 'work' ? 'work' : 'chat');
	const work = task === 'work';
	const [preference, setPreference] = useState(readToChatSource);
	const source = view?.session.config.model_source ?? preference;
	const [effort, setEffort] = useState<Effort>('high');
	const [officialModelId, setOfficialModelId] = useState<ToChatModelId>('deepseek-flash');
	const [customModel, setCustomModel] = useState<ChatModelConfig | null>(null);
	const [cwd, setCwd] = useState<string | null>(null);
	const [permission, setPermission] = useState('default');
	const [quota, setQuota] = useState<Quota | null>(null);
	const [quotaError, setQuotaError] = useState('');
	const [authReady, setAuthReady] = useState(false);
	const [connectionAttempt, setConnectionAttempt] = useState(0);
	const [configPending, setConfigPending] = useState(false);
	const selectedCwd = view ? view.session.config.cwd ?? null : cwd;
	const permissionContext = view?.session.state.permission_context as { mode?: string } | undefined;
	const selectedPermission = permissionContext?.mode ?? permission;
	const storedEffort = view?.session.config.chat_model_config?.parameters?.thinkingEffort;
	const candidateOfficial = toChatModel(view ? view.session.config.chat_model_config?.model : officialModelId);
	const selectedOfficial = modelAllowedInMode(candidateOfficial.id,task) ? candidateOfficial : toChatModel('deepseek-flash');
	const selectedEffort = toChatEffort(selectedOfficial.id, typeof storedEffort === 'string' ? storedEffort : effort);
	const officialModel: ChatModelConfig = { type: 'openai_compatible', credential_id: 'tora-tochat-official', model: selectedOfficial.id, parameters: { thinking: true, thinkingEffort: selectedEffort } };
	const builtinAccountToken = getToken();
	const model = source === 'official' ? officialModel : view?.session.config.chat_model_config ?? customModel;

	const refreshQuota = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetchBuiltinQuota(signal ?? AbortSignal.timeout(15_000));
			const data = await response.json();
			if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
			if (signal?.aborted) return;
			setQuota(data);
			setQuotaError('');
		} catch (error) {
			if (!signal?.aborted) setQuotaError(error instanceof Error ? error.message : String(error));
		}
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const sync = async () => {
			try {
				await syncBuiltinModelAuth();
				if (!controller.signal.aborted) setAuthReady(true);
			} catch (error) {
				if (!controller.signal.aborted) { setAuthReady(false); setQuotaError(String(error)); }
			}
			void refreshQuota(controller.signal);
		};
		void sync();
		window.addEventListener('tora-auth-changed', sync);
		const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshQuota(controller.signal); }, 30_000);
		return () => { controller.abort(); clearInterval(timer); window.removeEventListener('tora-auth-changed', sync); };
	}, [refreshQuota, connectionAttempt]);
	useEffect(() => {
		const update = () => setPreference(readToChatSource());
		window.addEventListener(TOCHAT_SOURCE_EVENT, update);
		return () => window.removeEventListener(TOCHAT_SOURCE_EVENT, update);
	}, []);
	useEffect(() => {
		if (!urlAgent && agentId) navigate(`/tochat/${agentId}?task=${task}`, { replace: true });
		if (view && view.session.config.application_mode !== 'tochat') navigate(`/chat/${agentId}/${sessionId}`, { replace: true });
	}, [urlAgent, agentId, task, navigate, view, sessionId]);

	const onCreated = (id: string) => {
		navigate(`/tochat/${agentId}/${id}?task=${task}`, { replace: true });
		void refetch();
	};
	const { msgs, loading, phase, send, onUserConfirm, interrupt, userQuestion, answerQuestion } = useMessages(agentId, sessionId ?? null, {
		onSessionCreated: onCreated,
		onSessionUpdated: () => { void refetch(); void refreshQuota(); },
		beforeSend: async () => {
			if (source !== 'official') return;
			if (!builtinAccountToken || builtinAccountToken !== getToken()) throw new Error(copy('connectError'));
			await syncBuiltinModelAuth();
			if (builtinAccountToken !== getToken()) throw new Error(copy('connectError'));
		},
		newSessionExtras: () => ({ application_mode: 'tochat', task_mode: task, model_source: source, web_search: true, chat_model_config: model, cwd: work ? selectedCwd : null, permission_mode: work ? selectedPermission : 'explore' }),
	});
	useEffect(() => { if (phase === 'idle') void refreshQuota(); }, [phase, refreshQuota]);
	const busy = phase !== 'idle' || configPending;
	// Hide during optimistic first-send, before session creation or history loads.
	const showTaskSwitcher = !sessionId && msgs.length === 0 && phase === 'idle';
	const limitReached = source === 'official' && work && quota && !quota.canUseAgent;
	useEffect(() => {if(source !== 'official' || !work)return;const timer=window.setInterval(()=>void refreshQuota(),phase==='idle'?30000:2000);return()=>window.clearInterval(timer);},[source,work,phase,refreshQuota]);
	const missingSession = !!sessionId && !view && !sessionsLoading && !loading;
	const disabled = !agentId || !model || missingSession || configPending || (source === 'official' && (!authReady || !quota?.enabled || !modelAvailable(selectedOfficial.id, quota?.models) || !!quotaError || (phase==='idle'&&!!limitReached)));
	const patch = async (config: UpdateSessionRequest) => {
		if (busy && !(Object.keys(config).length === 1 && 'permission_mode' in config)) return false;
		setConfigPending(true);
		try {
			if (sessionId && agentId) { await sessionApi.update(sessionId, agentId, config); await refetch(); }
			return true;
		} catch { return false; } finally { setConfigPending(false); }
	};
	const fresh = (kind: ToChatTask) => {
		if (busy || !agentId) return;
		setCwd(null);
		navigate(`/tochat/${agentId}?task=${kind}`);
	};
	const chooseEffort = async (next: Effort) => {
		if (await patch({ chat_model_config: { ...officialModel, parameters: { thinking: true, thinkingEffort: next } } })) setEffort(next);
	};
	const chooseOfficialModel = async (id: ToChatModelId) => {
		if (!modelAllowedInMode(id,task)) return;
		const nextEffort = toChatEffort(id, selectedEffort);
		if (await patch({ chat_model_config: { ...officialModel, model: id, parameters: { thinking: true, thinkingEffort: nextEffort } } })) { setOfficialModelId(id); setEffort(nextEffort); }
	};
	const attachmentModel = source === 'official' ? selectedOfficial.id : 'custom';
	const fileProcessor = async (file: File): Promise<ContentBlock | null> => {
		try { return await processChatAttachment(file,attachmentModel,task); }
		catch { toast.error(attachmentModel.startsWith('doubao') ? t('textInput.mediaError') : copy('imageError')); return null; }
	};

	return (
		<main className="flex h-full min-w-0 flex-col bg-transparent" data-testid="tochat-page">
			<header data-window-drag-region className="app-drag flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-5">
				<div className="flex min-w-0 items-center gap-2">
					<SidebarTrigger className="md:hidden" />
					{showTaskSwitcher && (<div className="flex shrink-0 items-center rounded-full bg-muted p-0.5" data-testid="tochat-task-switcher" role="group" aria-label="ToChat">
						{(['chat', 'work'] as const).map((kind) => (
							<button key={kind} type="button" disabled={busy} aria-pressed={task === kind} onClick={() => fresh(kind)} className={`relative isolate rounded-full px-3 py-1 text-xs disabled:opacity-50 ${task === kind ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
								{task === kind && <motion.span
									data-testid="tochat-task-indicator"
									data-motion={tabMotion}
									aria-hidden="true"
									initial={false}
									layoutId={tabMotion === 'off' ? undefined : 'tochat-task-indicator'}
									transition={TAB_TRANSITIONS[tabMotion]}
									className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-background shadow-sm"
								/>}
								{copy(kind)}
								</button>
						))}
					</div>)}
					{msgs.length > 0 && <span className="hidden truncate text-sm text-muted-foreground lg:block">{view?.session.config.name}</span>}
				</div>
				<WindowDragRegion className="min-w-6 flex-1 self-stretch" />
				<Popover>
					<PopoverTrigger className="flex max-w-[45%] items-center gap-1 rounded-md px-1 py-1 text-xs text-muted-foreground hover:text-foreground" aria-label={copy('quota')}>
						<span className="truncate">{source === 'custom' ? copy('customQuota') : quotaError ? copy('quotaError') : !quota ? copy('quotaLoading') : work ? `${(quota.remainingPercent??0).toFixed(1)}%` : copy('chatUnlimited')}</span><ChevronDown className="size-3 shrink-0" />
					</PopoverTrigger>
					<PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm">
						<h3 className="font-medium">{copy('quota')}</h3>
						{work ? <AgentQuotaMeter quota={quota} /> : <p>{copy('chatUnlimited')}</p>}
						{quotaError && <p className="text-xs text-destructive">{quotaError}</p>}
						<Button variant="ghost" size="sm" onClick={() => setConnectionAttempt((attempt) => attempt + 1)}><RotateCw />{copy('retry')}</Button>
					</PopoverContent>
				</Popover>
			</header>
			<div className="canvas-glow relative flex min-h-0 flex-1 justify-center overflow-hidden [--chat-content-w:54rem]">
				<ChatContent className="max-w-[var(--chat-content-w)] w-full" msgs={msgs} loading={loading} phase={phase} disabled={disabled}
					composerNotice={missingSession || (source === 'official' && (quotaError || (quota && (!quota.enabled || !modelAvailable(selectedOfficial.id, quota.models))) || limitReached)) ? copy(missingSession ? 'missingSession' : limitReached ? 'limitReached' : 'connectError') : undefined}
					greetingOverride={copy(work ? 'workReady' : 'ready')} showWorkspace={work} cwd={work ? selectedCwd : null}
					composerVariant={work ? 'default' : 'capsule'}
					onCwdChange={async (next) => { if (await patch({ cwd: next })) setCwd(next); }}
					onSend={(content, context, skills) => { if (!model) { toast.error(copy('selectModel')); return; } void send(content, context, skills); }}
					onUserConfirm={onUserConfirm} onInterrupt={interrupt} allowedInputTypes={chatAttachmentTypes(attachmentModel,task)} fileProcessor={fileProcessor}
					permissionControl={work ? <PermissionModeSelect composer value={selectedPermission} disabled={configPending} onChange={async (next) => { if (await patch({ permission_mode: next })) setPermission(next); }} /> : undefined}
					modelControl={source === 'custom' ? <LlmSelect id="tour-model-selector" composer value={model} includeBuiltin={false} disabled={busy} onChange={async (next) => { if (next && await patch({ chat_model_config: next })) setCustomModel(next); }} onAddCredential={() => openSettings('model')} /> :
						<OfficialModelSelect mode={task} model={selectedOfficial.id} effort={selectedEffort} models={quota?.models} disabled={busy} onModel={id => void chooseOfficialModel(id)} onEffort={level => void chooseEffort(level as Effort)} />}
					footerSlot={userQuestion ? <QuestionPanel entry={userQuestion} onSubmit={(answers, note) => answerQuestion(userQuestion, { answers, note })} onCancel={() => answerQuestion(userQuestion, { answers: [], cancelled: true })} /> : undefined}
				/>
			</div>
		</main>
	);
}

export function ToChatPage() {
	return <AudioProvider><ToChatConversation /></AudioProvider>;
}
