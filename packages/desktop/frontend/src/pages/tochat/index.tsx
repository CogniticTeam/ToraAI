import { motion } from 'framer-motion';
import { Globe, PanelRight } from 'lucide-react';
import { lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import {sessionHistoryKind} from '../../../../../core/src/session-mode.js';
import { type ContentBlock, type UpdateSessionRequest } from '@/api';
import { ChatContent } from '@/components/chat/ChatContent';
import { QuestionPanel } from '@/components/chat/QuestionPanel';
import { WindowDragRegion } from '@/components/layout/WindowDragRegion';
import {PanelDock} from '@/components/panel/PanelDock';
import { AgentSelect } from '@/components/select/AgentSelect';
import { LlmSelect } from '@/components/select/LlmSelect';
import { PermissionModeSelect } from '@/components/select/PermissionModeSelect';
import { Button } from '@/components/ui/button';
import {ResizablePanelGroup,ResizablePanel} from '@/components/ui/resizable';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { AudioProvider } from '@/context/AudioContext';
import { useAgents } from '@/hooks/useAgents';
import { isChatModelAvailable, useAvailableModels } from '@/hooks/useAvailableModels';
import { useRoleModel } from '@/hooks/useRoleModel';
import { useMessages } from '@/hooks/useMessages';
import { useMotionSettings } from '@/hooks/useMotionSettings';
import { useSessions } from '@/hooks/useSessions';
import { useTranslation } from '@/i18n/useI18n';
import { modeCopy, type ToChatTask } from '@/lib/applicationModes';
import {takeBrowserPanel} from '@/lib/browserStart';
import {chatAttachmentTypes, processChatAttachment} from '@/lib/chatAttachments';
import {OPEN_PANEL_EVENT,type PanelOpenDetail} from '@/lib/openPanel';
import { openSettings } from '@/lib/openSettings';
import {restoreUIState,useUICheckpoint} from '@/lib/uiCheckpoint';
import { isDeepSeekModel } from '../../../../../core/src/deepseek-model.js';
const BrowserPanel=lazy(async()=>({default:(await import('@/components/panel/BrowserPanel')).BrowserPanel}));
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
	const { groups: availableGroups, loading: modelsLoading } = useAvailableModels(false, false);
	const groups = useMemo(() => Object.fromEntries(Object.entries(availableGroups).map(([type, credentials]) => [
		type, credentials.map(item => ({ ...item, models: item.models.filter(model => isDeepSeekModel(model.name)) })),
	])), [availableGroups]);
	const agentId = urlAgent || agents[0]?.id || null;
	const agent = agents.find(item => item.id === agentId);
	const { sessions, loading: sessionsLoading, refetch, update: updateSession } = useSessions(agentId);
	const view = sessions.find((item) => item.session.id === sessionId);
	const { i18n, t } = useTranslation();
	const copy = modeCopy(i18n.language);
	const { effective, clickEnabled } = useMotionSettings();
	const tabMotion = clickEnabled ? effective : 'off';
	const task: ToChatTask = view ? sessionHistoryKind(view.session.config) : (params.get('task') === 'work' ? 'work' : 'chat');
	const work = task === 'work';
	const [browserOpen,setBrowserOpen]=useState(false);
	useEffect(()=>{
		setBrowserOpen(false);
		if(!work)return;
		const open=(event:Event)=>{const detail=(event as CustomEvent<PanelOpenDetail>).detail;if((typeof detail==='string'?detail:detail?.key)==='browser')setBrowserOpen(true);};
		window.addEventListener(OPEN_PANEL_EVENT,open);
		if(work&&takeBrowserPanel((window.location?.pathname??'')+(window.location?.search??''))==='browser')setBrowserOpen(true);
		return()=>window.removeEventListener(OPEN_PANEL_EVENT,open);
	},[work]);
	const [cwd, setCwd] = useState<string | null>(()=>restoreUIState('tochat-cwd',null));
	const [permission, setPermission] = useState(()=>restoreUIState('tochat-permission','default'));
	useUICheckpoint('tochat-cwd',cwd);useUICheckpoint('tochat-permission',permission);
	const [configPending, setConfigPending] = useState(false);
	const configLock = useRef(false);
	const configScope = useRef(0);
	useEffect(() => {
		configScope.current += 1;
		configLock.current = false;
		setConfigPending(false);
	}, [agentId, sessionId]);
	const selectedCwd = view ? view.session.config.cwd ?? null : cwd;
	const permissionContext = view?.session.state.permission_context as { mode?: string } | undefined;
	const selectedPermission = permissionContext?.mode ?? permission;
	const { model, selectModel, sessionCreated } = useRoleModel({
		agentId, sessionId: sessionId ?? null, sessionModel: view?.session.config.chat_model_config, groups, modelsLoading,
		defaultModel: agent?.data.chat_model_config, checkpointKey: 'tochat-custom', draftKey: task,
	});
	const modelUnavailable = !!model && !modelsLoading && (!isDeepSeekModel(model.model) || !isChatModelAvailable(groups, model));

	useEffect(() => {
		if (!urlAgent && agentId) navigate(`/tochat/${agentId}?task=${task}`, { replace: true });
	}, [urlAgent, agentId, task, navigate, view, sessionId]);

	const onCreated = (id: string) => {
		sessionCreated(id);
		navigate(`/tochat/${agentId}/${id}?task=${task}`, { replace: true });
		void refetch();
	};
	const { msgs, loading, phase, send, resume, onUserConfirm, interrupt, userQuestion, answerQuestion, deleteMessage } = useMessages(agentId, sessionId ?? null, {
		viewMode: 'tochat',
		onSessionCreated: onCreated,
		onSessionUpdated: () => { void refetch(); },
		newSessionExtras: () => ({ application_mode: 'tochat', task_mode: task, model_source: 'custom', web_search: true, chat_model_config: model, cwd: work ? selectedCwd : null, permission_mode: work ? selectedPermission : 'explore' }),
	});
	const busy = phase !== 'idle' || configPending;
	// Hide during optimistic first-send, before session creation or history loads.
	const showTaskSwitcher = !sessionId && msgs.length === 0 && phase === 'idle';
	const missingSession = !!sessionId && !view && !sessionsLoading && !loading && phase === 'idle';
	const disabled = !agentId || !model || modelUnavailable || (!!model.credential_id && modelsLoading) || missingSession || configPending;
	const patch = async (config: UpdateSessionRequest) => {
		if (configLock.current || (busy && !(Object.keys(config).length === 1 && 'permission_mode' in config))) return false;
		const scope = configScope.current;
		configLock.current = true;
		setConfigPending(true);
		try {
			if (sessionId && agentId) await updateSession(sessionId, config);
			return scope === configScope.current;
		} catch { return false; } finally {
			if (scope === configScope.current) {
				configLock.current = false;
				setConfigPending(false);
			}
		}
	};
	const fresh = (kind: ToChatTask) => {
		if (busy || !agentId) return;
		setCwd(null);
		navigate(`/tochat/${agentId}?task=${kind}`);
	};
	const fileProcessor = async (file: File): Promise<ContentBlock | null> => {
		try { return await processChatAttachment(file, 'custom', task, 32 * 1024 * 1024); }
		catch { toast.error(copy('imageError')); return null; }
	};

	return (
		<main className="flex h-full min-w-0 flex-col bg-transparent" data-testid="tochat-page">
			<header data-window-drag-region className="app-drag flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-5">
				<div className="flex min-w-0 max-w-[70%] items-center gap-2">
					<SidebarTrigger className="md:hidden" />
					<AgentSelect agents={agents} value={agentId} variant="ghost" className="max-w-40 shrink" data-testid="agent-role-picker" disabled={busy || !agentId} onChange={id => { if (id !== agentId) navigate(`/tochat/${id}?task=${task}`); }} onManage={() => openSettings('agent')} />
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
				<div className="relative flex min-w-6 flex-1 self-stretch items-center justify-center">
					<WindowDragRegion className="absolute inset-0" />
				</div>
				{work&&<Button variant="ghost" size="icon-sm" aria-label={t('panelDock.toggle')} aria-pressed={browserOpen} onClick={()=>setBrowserOpen(value=>!value)}><PanelRight/></Button>}
			</header>
			<ResizablePanelGroup orientation="horizontal" className="chat-dock min-h-0 flex-1" data-motion={clickEnabled?effective:'off'}>
			<ResizablePanel className="flex min-h-0 min-w-0" minSize={work?'24rem':0}>
			<div className="canvas-glow relative flex min-h-0 flex-1 justify-center overflow-hidden [--chat-content-w:54rem]">
				<ChatContent onDeleteMessage={deleteMessage} className="max-w-[var(--chat-content-w)] w-full" msgs={msgs} loading={loading} phase={phase} disabled={disabled} sendDisabled={disabled}
					composerNotice={missingSession ? copy('missingSession') : modelUnavailable ? t('agentSection.modelUnavailable') : !model ? copy('selectModel') : undefined}
					greetingOverride={copy(work ? 'workReady' : 'ready')} showWorkspace={work} cwd={work ? selectedCwd : null}
					composerVariant={work ? 'default' : 'capsule'}
					onCwdChange={async (next) => { if (await patch({ cwd: next })) setCwd(next); }}
					onSend={(content, context, skills) => { if (!model) { toast.error(copy('selectModel')); return; } return send(content, context, skills); }}
					onUserConfirm={onUserConfirm} onInterrupt={interrupt} allowedInputTypes={chatAttachmentTypes('custom', task)} fileProcessor={fileProcessor}
					onResume={work ? resume : undefined}
					permissionControl={work ? <PermissionModeSelect composer value={selectedPermission} disabled={configPending} onChange={async (next) => { if (await patch({ permission_mode: next })) setPermission(next); }} /> : undefined}
					modelControl={<LlmSelect key={`${agentId}:${sessionId ?? task}`} id="tour-model-selector" composer value={model} modelFilter={isDeepSeekModel} disabled={busy || !agentId} onChange={async (next) => { if (next && await patch({ chat_model_config: next })) selectModel(next); }} onAddCredential={() => openSettings('model')} />}
					footerSlot={userQuestion ? <QuestionPanel entry={userQuestion} onSubmit={(answers, note) => answerQuestion(userQuestion, { answers, note })} onCancel={() => answerQuestion(userQuestion, { answers: [], cancelled: true })} /> : undefined}
				/>
			</div>
			</ResizablePanel>
			<PanelDock layout={work&&browserOpen?[['browser']]:[]} panels={{browser:{title:t('panel.workspace.browser'),icon:<Globe className="size-4" />,content:<BrowserPanel />}}} onClosePanel={()=>setBrowserOpen(false)} onCloseDock={()=>setBrowserOpen(false)} />
			</ResizablePanelGroup>
		</main>
	);
}

export function ToChatPage() {
	return <AudioProvider><ToChatConversation /></AudioProvider>;
}
