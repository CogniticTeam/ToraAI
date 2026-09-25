import { EventType } from '@agentscope-ai/agentscope/event';
import type {
	AgentEvent,
	CustomEvent,
	DataBlockStartEvent,
	DataBlockDeltaEvent,
	DataBlockEndEvent,
	ReplyStartEvent,
	RequireUserConfirmEvent,
	UserConfirmResultEvent,
} from '@agentscope-ai/agentscope/event';
import { appendEvent, AssistantMsg, UserMsg } from '@agentscope-ai/agentscope/message';
import type { Msg, ContentBlock } from '@agentscope-ai/agentscope/message';
import type { ToolCallBlock } from '@agentscope-ai/agentscope/message';
import { useState, useCallback, useRef, useEffect } from 'react';

import type { CreateSessionRequest } from '@/api';
import { sessionApi, takeFreshlyCreated } from '@/api';
import { chatApi } from '@/api';
import { useAudioManager } from '@/context/AudioContext';
import { playNotificationSound } from '@/lib/sound';

/**
 * One pending subagent HITL request, projected from a team *member*
 * session onto its *leader* session so the leader UI can render and
 * resolve it. Mirrors the Python payload written by
 * ``SubagentHitlProjector`` and pushed/replayed as a ``CustomEvent``
 * (``name="subagent_require_user_confirm"``).
 */
export type SubagentHitlEntry = {
	worker_session_id: string;
	worker_agent_id: string;
	worker_agent_name: string;
	reply_id: string;
	event_type: 'require_user_confirm' | 'require_external_execution';
	/** The original ``RequireUserConfirmEvent`` payload (serialized). */
	event: { tool_calls?: ToolCallBlock[] } & Record<string, unknown>;
	created_at: string;
};

/**
 * Return true if ``msg`` is an assistant reply currently parked on a
 * pending tool_call (awaiting user confirmation or an external
 * execution result). Used both to detect the "in-flight reply on page
 * load" case and as the SDK-gap workaround that hides the confirm
 * card once the paired tool_result lands.
 */
const hasPendingToolCall = (msg: Msg | undefined): boolean => {
	if (!msg || msg.role !== 'assistant') return false;
	for (const block of msg.content) {
		if (block.type !== 'tool_call') continue;
		const state = (block as ToolCallBlock).state;
		if (state === 'asking' || state === 'submitted') return true;
	}
	return false;
};

const hitlKey = (e: { worker_session_id: string; reply_id: string }) =>
	`${e.worker_session_id}:${e.reply_id}`;

/**
 * A pending AskUserQuestion round: the agent parked the run and pushed
 * ``user_question_requested`` (a CustomEvent). The QuestionPanel floats
 * above the composer until the user answers or the run ends
 * (``user_question_answered`` / ``user_question_cancelled``).
 */
export type UserQuestionEntry = {
	ask_id: string;
	reply_id: string;
	questions: Array<{
		question: string;
		header: string;
		options: Array<{ label: string; description: string }>;
		multiSelect?: boolean;
	}>;
};

/**
 * Lifecycle phase of the reply currently owned by this session.
 *
 * - ``idle`` — no in-flight reply; the send button is enabled.
 * - ``streaming`` — a reply is in progress (either actively producing
 *   events or parked awaiting HITL). The send button is replaced by a
 *   Stop button. The parked-vs-generating distinction is not tracked
 *   here; HITL cards render themselves from message content when a
 *   ``RequireUserConfirmEvent`` block is present.
 * - ``interrupting`` — the user has requested a stop and we are
 *   waiting for the backend's terminating ``ReplyEndEvent``. Stop
 *   button is shown but disabled so users cannot spam it. Falls back
 *   to ``idle`` after a 10s safety timeout in case the terminating
 *   event never arrives (dropped SSE frame, backend bug, etc.).
 */
export type ReplyPhase = 'idle' | 'streaming' | 'interrupting';

/** Safety fallback: force phase back to idle if REPLY_END is not seen. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * Manages messages for a single ``(agentId, sessionId)`` pair.
 *
 * Event delivery has two independent channels:
 *
 * - **History** — ``GET /sessions/{sid}/messages`` fetches persisted
 *   ``Msg`` objects (each a complete reply).
 * - **Live stream** — ``GET /sessions/{sid}/stream`` is a long-lived
 *   SSE connection that pushes ``AgentEvent`` deltas as they are
 *   produced by any chat run on this session (user-triggered,
 *   background retrigger, team member message, …).
 *
 * The hook opens the SSE connection immediately after fetching
 * history. User input and human-in-the-loop confirmations are sent
 * via ``POST /chat/`` (fire-and-forget); the resulting events arrive
 * through the already-open SSE connection.
 *
 * ``phase`` is driven by event content, not HTTP lifecycle: it moves
 * to ``streaming`` on ``ReplyStartEvent`` and back to ``idle`` on
 * ``ReplyEndEvent``. Calling ``interrupt()`` moves it to
 * ``interrupting`` until the terminating ``ReplyEndEvent`` arrives (or
 * a 10s safety timeout fires).
 *
 * @param agentId - The agent whose session to subscribe. ``null`` to
 *   skip.
 * @param sessionId - The session to subscribe. ``null`` to skip.
 * @returns Object with ``msgs``, ``loading``, ``phase``, ``error``,
 *   ``send``, ``onUserConfirm``, and ``abort``. ``loading`` stays true
 *   until the history for the *current* ``(agentId, sessionId)`` has
 *   landed, so ``msgs`` must not be rendered while it is set.
 */
export function useMessages(
	agentId: string | null,
	sessionId: string | null,
	options?: {
		/**
		 * Called when a ``CUSTOM`` event with ``name="team_updated"``
		 * arrives — the team membership has changed (TeamCreate /
		 * AgentCreate / TeamDelete ran). The typical response is to
		 * refetch the session list so the team sidebar updates.
		 */
		onTeamUpdated?: () => void;
		/**
		 * Called when a ``CUSTOM`` event with ``name="state_updated"``
		 * arrives — agent state (tasks / permission) changed during a
		 * tool call. The ``value`` payload contains the latest
		 * ``tasks_context`` and ``permission_context``.
		 */
		onStateUpdated?: (value: Record<string, unknown>) => void;
		/**
		 * Called when a ``CUSTOM`` event with ``name="session_updated"``
		 * arrives — the session record changed server-side, currently
		 * only when auto-naming replaced its placeholder name. Refetch
		 * the session list to pick the new one up.
		 */
		onSessionUpdated?: () => void;
		/**
		 * Called when a ``CUSTOM`` event with ``name="context_compacted"``
		 * arrives — the agent's context exceeded the configured token
		 * budget and older history was evicted / summarised. The value
		 * carries ``{evicted, compacted, tokensBefore, tokensAfter, budget}``.
		 * Intended for surfacing a non-blocking notice so the user knows
		 * why earlier detail may no longer be available.
		 */
		onContextCompacted?: (info: {
			evicted: number;
			compacted: boolean;
			tokensBefore: number;
			tokensAfter: number;
			budget: number;
		}) => void;
		/**
		 * Called when ``send`` had to create a brand-new session because
		 * the hook was opened without one. The host is expected to update
		 * the URL (e.g. ``navigate('/chat/:agent/:newId')``) so a reload
		 * lands the user back in the conversation they just started.
		 */
		onSessionCreated?: (sessionId: string) => void;
		/**
		 * Extra fields merged into the session ``send`` auto-creates when
		 * the hook was opened without one. Read at call time, so the host
		 * can hand back state it only keeps in memory — the model picked in
		 * an empty conversation has nowhere else to live until the session
		 * exists, and dropping it would silently run the first reply on the
		 * default model.
		 */
		newSessionExtras?: () => Partial<CreateSessionRequest>;
	},
) {
	const [msgs, setMsgs] = useState<Msg[]>([]);
	// The (agent, session) pair `msgs` actually belongs to. Loading is
	// derived from it rather than set inside the fetch effect: an effect
	// runs *after* the render that changed `sessionId`, so a flag it owns
	// is still `false` for one frame — long enough to paint the empty
	// state over a session that does have messages.
	const [loadedKey, setLoadedKey] = useState<string | null>(null);
	const [phase, setPhase] = useState<ReplyPhase>('idle');
	const [error, setError] = useState<Error | null>(null);
	// Pending subagent HITL cards projected onto this (leader) session.
	const [subagentHitl, setSubagentHitl] = useState<SubagentHitlEntry[]>([]);
	// Pending AskUserQuestion round (at most one — the agent awaits it).
	const [userQuestion, setUserQuestion] = useState<UserQuestionEntry | null>(null);

	const msgsRef = useRef<Msg[]>([]);
	const currentReplyRef = useRef<Msg | null>(null);
	// 空态首发消息共享的「建会话」promise：连发两条消息时 URL 还没翻转、
	// sessionId 仍为 null，不能再建第二个会话——两条落进同一个新会话。
	// create 失败时清空以便下次重试；会话切换/接管后旧 promise 失去意义，
	// 在生命周期 effect 开头归零。
	const pendingCreateRef = useRef<Promise<string> | null>(null);
	/**
	 * Reply ids whose ``REPLY_START`` we have already applied *on this SSE
	 * connection*. Cleared whenever the connection is (re)opened.
	 *
	 * This is what distinguishes the two very different meanings of a
	 * ``REPLY_START`` that names a message we already hold:
	 *
	 * - Not in the set → the server is **replaying the buffered events of a
	 *   run in flight**, and the copy we hold came from the history
	 *   snapshot. Both describe the same reply, so the replay must rebuild
	 *   it from scratch (see the handler).
	 * - In the set → a genuine re-emit on a run we are already streaming;
	 *   only new events follow, so the accumulated content must survive.
	 */
	const startedRepliesRef = useRef<Set<string>>(new Set());
	const abortRef = useRef<AbortController | null>(null);
	const rafRef = useRef<number | null>(null);
	// 用户主动打断过当前回复时置 true：随后的 REPLY_END 只是打断的收尾，
	// 不该触发「回复完成」提示音。REPLY_START 时复位。
	const interruptedRef = useRef(false);
	// Timer that reverts ``interrupting`` back to ``idle`` if the
	// terminating REPLY_END never arrives (dropped SSE frame, etc.).
	const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearInterruptTimer = useCallback(() => {
		if (interruptTimerRef.current !== null) {
			clearTimeout(interruptTimerRef.current);
			interruptTimerRef.current = null;
		}
	}, []);

	const audioManager = useAudioManager();

	const optionsRef = useRef(options);
	useEffect(() => {
		optionsRef.current = options;
	}, [options]);
	const scheduleUpdate = useCallback(() => {
		if (rafRef.current !== null) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			setMsgs([...msgsRef.current]);
		});
	}, []);

	/** Apply a single AgentEvent to the in-progress reply. */
	const processEvent = useCallback(
		(event: AgentEvent) => {
			// Custom events are service-layer notifications, not agent
			// reply content — route them to callbacks and skip appendEvent.
			if (event.type === EventType.CUSTOM) {
				const custom = event as CustomEvent;
				if (custom.name === 'team_updated') {
					optionsRef.current?.onTeamUpdated?.();
				} else if (custom.name === 'state_updated' && custom.value) {
					optionsRef.current?.onStateUpdated?.(custom.value as Record<string, unknown>);
				} else if (custom.name === 'session_updated') {
					optionsRef.current?.onSessionUpdated?.();
				} else if (custom.name === 'context_compacted' && custom.value) {
					optionsRef.current?.onContextCompacted?.(
						custom.value as {
							evicted: number;
							compacted: boolean;
							tokensBefore: number;
							tokensAfter: number;
							budget: number;
						},
					);
				} else if (custom.name === 'subagent_require_user_confirm') {
					// A team member is asking for confirmation; show (or
					// refresh) its card on this leader view. Dedup by
					// (worker_session_id, reply_id).
					const e = custom.value as unknown as SubagentHitlEntry;
					setSubagentHitl((prev) => [
						...prev.filter((x) => hitlKey(x) !== hitlKey(e)),
						e,
					]);
				} else if (custom.name === 'subagent_user_confirm_result') {
					// The member resolved (or its run ended); clear the card.
					const v = custom.value as { worker_session_id: string; reply_id: string };
					setSubagentHitl((prev) => prev.filter((x) => hitlKey(x) !== hitlKey(v)));
				} else if (custom.name === 'user_question_requested' && custom.value) {
					// Agent parked the run asking the user to choose; show the
					// panel. Dedup by ask_id — SSE replay on reconnect must
					// not stack panels, and a re-delivered request should
					// refresh (not duplicate) the existing one.
					const v = custom.value as unknown as UserQuestionEntry;
					if (v?.ask_id) {
						setUserQuestion((prev) => (prev?.ask_id === v.ask_id ? prev : v));
						// 需要用户作答 —— 提示音（引擎内部有防抖，重放不连击）。
						playNotificationSound('need_confirm');
					}
				} else if (custom.name === 'user_question_answered' && custom.value) {
					const { ask_id } = custom.value as { ask_id: string };
					setUserQuestion((prev) => (prev?.ask_id === ask_id ? null : prev));
				} else if (custom.name === 'user_question_cancelled' && custom.value) {
					const { ask_id } = custom.value as { ask_id: string };
					setUserQuestion((prev) => (prev?.ask_id === ask_id ? null : prev));
				} else if (custom.name === 'confirm_invalidated' && custom.value) {
					// The backend invalidated confirmation cards that can no
					// longer be resolved (run ended/aborted, or a late answer
					// raced the run's completion). Flip every still-asking
					// tool_call on that reply so the card stops being
					// clickable — answering it would only hit a stale error.
					const { reply_id } = custom.value as { reply_id: string };
					let touched = false;
					msgsRef.current = msgsRef.current.map((m) => {
						if (m.id !== reply_id) return m;
						let flipped = false;
						const content = m.content.map((b) => {
							if (b.type === 'tool_call' && (b as ToolCallBlock).state === 'asking') {
								flipped = true;
								return { ...b, state: 'finished' as const };
							}
							return b;
						});
						if (flipped) touched = true;
						return flipped ? { ...m, content } : m;
					});
					if (touched) scheduleUpdate();
				}
				return;
			}
			if (event.type === EventType.REPLY_START) {
				const e = event as ReplyStartEvent;
				// A continuation (the run resuming after a confirmation or an
				// external execution result) re-emits REPLY_START with the
				// *same* reply_id. Re-point at the existing reply instead of
				// appending a second msg under that id: a duplicate would
				// collide on React keys, strand the original bubble in its
				// running state, and hide any still-pending confirmation card
				// — those are read off the tail msg, which would be the empty
				// duplicate.
				const existing = msgsRef.current.find((m) => m.id === e.reply_id);
				if (existing && !startedRepliesRef.current.has(e.reply_id)) {
					// Re-attached mid-run: the history snapshot and the replayed
					// event buffer describe the *same* reply, and the replay
					// starts at REPLY_START. Layering one on the other is what
					// produced duplicated blocks, tool inputs appended twice,
					// and a ghost tool_call with an empty input. Resetting to a
					// blank reply and letting the replay rebuild it is the only
					// idempotent option.
					//
					// The events are guaranteed to be complete: the buffer is
					// only cleared once the run ends.
					const fresh = AssistantMsg({ id: existing.id, name: existing.name, content: [] });
					if (existing.metadata) fresh.metadata = existing.metadata;
					msgsRef.current = msgsRef.current.map((m) => (m === existing ? fresh : m));
					currentReplyRef.current = fresh;
				} else if (existing) {
					currentReplyRef.current = existing;
				} else {
					audioManager?.stopAllPlayback();
					const msg = AssistantMsg({ id: e.reply_id, name: e.name, content: [] });
					msgsRef.current = [...msgsRef.current, msg];
					currentReplyRef.current = msg;
				}
				startedRepliesRef.current.add(e.reply_id);
				clearInterruptTimer();
				interruptedRef.current = false;
				setPhase('streaming');
			} else {
				if (currentReplyRef.current) {
					const reply = currentReplyRef.current;
					// ``appendEvent`` resolves REQUIRE_USER_CONFIRM by looking up
					// the tool_call block and silently skipping when it is
					// absent — which strands the user: no card, and the call
					// sits in ``pending`` forever. Backfill the block from the
					// event itself so a confirmation can never disappear.
					if (event.type === EventType.REQUIRE_USER_CONFIRM) {
						for (const tc of (event as RequireUserConfirmEvent).tool_calls ?? []) {
							if (!reply.content.some((b) => b.type === 'tool_call' && b.id === tc.id)) {
								reply.content.push({ ...tc });
							}
						}
						// 有确认卡在等用户拍板 —— 提示音（引擎内部防抖）。
						playNotificationSound('need_confirm');
					}
					appendEvent(reply, event);
					// ``appendEvent`` mutates in place, which would leave
					// every Msg identical across renders and force the whole
					// list to re-render on each delta. Republish just the
					// reply that changed under a fresh identity, so the
					// memoised bubbles of the other messages can skip the
					// render. Anything holding a Msg reference across events
					// must re-read it from here — ``currentReplyRef`` below,
					// everything else looks the reply up by id.
					const updated = { ...reply, content: [...reply.content] };
					msgsRef.current = msgsRef.current.map((m) => (m === reply ? updated : m));
					currentReplyRef.current = updated;
				}
				if (event.type === EventType.REPLY_END) {
					clearInterruptTimer();
					// 回复收尾：用户没主动打断过才响「回复完成」提示音。
					if (!interruptedRef.current) playNotificationSound('reply_done');
					interruptedRef.current = false;
					setPhase('idle');
					currentReplyRef.current = null;
				}
			}

			// Route streaming audio DataBlocks to the audio manager. They still
			// flow through `appendEvent` above (which builds up `source.data`
			// in the Msg), but MessageBubble reads playback state from the
			// manager so it can show progress and autoplay on completion.
			if (audioManager) {
				if (event.type === EventType.DATA_BLOCK_START) {
					const e = event as DataBlockStartEvent;
					if (e.media_type.startsWith('audio/')) {
						audioManager.start(e.block_id, e.media_type);
					}
				} else if (event.type === EventType.DATA_BLOCK_DELTA) {
					const e = event as DataBlockDeltaEvent;
					if (e.media_type.startsWith('audio/')) {
						audioManager.append(e.block_id, e.data);
					}
				} else if (event.type === EventType.DATA_BLOCK_END) {
					const e = event as DataBlockEndEvent;
					// `end` is a no-op when the block isn't being tracked, so
					// we can call it unconditionally.
					audioManager.end(e.block_id);
				}
			}

			scheduleUpdate();
		},
		[scheduleUpdate, audioManager, clearInterruptTimer],
	);

	// ── Lifecycle: fetch history + open SSE stream ──────────────────
	useEffect(() => {
		// 无论切到哪个会话，旧的「建会话」promise 都不再相关：清零，
		// 避免下一次空态首发复用到已消费/已失败的 promise。
		pendingCreateRef.current = null;
		// 本 tab 刚自动创建的会话：send() 已经把用户消息乐观追加进内存，
		// 这就是全部历史 —— **原样接管**（只标记已加载，不重置、不拉取）。
		// 放在最前面：早先的实现先重置再查 freshlyCreated，会把刚追加的
		// 用户消息一起抹掉 —— 用户视角就是"发了消息但新对话是空的"。
		const adopted = sessionId ? takeFreshlyCreated(sessionId) : false;
		if (adopted) {
			setLoadedKey(`${agentId}:${sessionId}`);
		} else {
			setLoadedKey(null);
			msgsRef.current = [];
			currentReplyRef.current = null;
			startedRepliesRef.current = new Set();
			setMsgs([]);
			setError(null);
			clearInterruptTimer();
			setPhase('idle');
			setSubagentHitl([]);
			setUserQuestion(null);
			audioManager?.disposeAll();
		}

		if (!agentId || !sessionId) return;

		const controller = new AbortController();
		abortRef.current = controller;
		let cancelled = false;

		(async () => {
			// 1. Fetch persisted history — skipped for an adopted session
			// (provably no server-side history beyond what we already hold).
			if (!adopted) {
				try {
					const { messages, is_running } = await sessionApi.messages(sessionId, agentId);
					if (cancelled) return;
					msgsRef.current = messages;
					// If a reply is in flight (running on a worker) OR the
					// tail msg is parked on a pending tool_call (awaiting
					// user confirmation / external execution), initialise the
					// phase to ``streaming`` so the interrupt button is
					// available immediately — otherwise a fresh page load
					// while parked leaves the UI stuck on ``idle`` with no
					// way to abort.
					const tail = messages[messages.length - 1];
					if (is_running || hasPendingToolCall(tail)) {
						setPhase('streaming');
						if (hasPendingToolCall(tail)) {
							// Prime the ref so continuation events (which
							// arrive without a fresh REPLY_START) apply to
							// the right msg.
							currentReplyRef.current = tail ?? null;
						}
					}
					// Published synchronously, not through `scheduleUpdate`:
					// its requestAnimationFrame batching exists for
					// high-frequency streaming deltas, and deferring here
					// would let `loadedKey` below clear `loading` a frame
					// before the messages land — painting the empty-session
					// greeting over a conversation that does have history.
					// Both setters now land in the same React batch.
					setMsgs([...msgsRef.current]);
				} catch (e) {
					if (!cancelled) setError(e as Error);
					return;
				} finally {
					// Marks the load done whether it succeeded or threw —
					// an error surfaces through `error`, and leaving
					// `loading` stuck on would hide it behind a spinner
					// forever.
					if (!cancelled) setLoadedKey(`${agentId}:${sessionId}`);
				}
			}

			// 2. Open SSE long connection for live events
			try {
				for await (const event of sessionApi.streamEvents(
					sessionId,
					agentId,
					controller.signal,
				)) {
					if (cancelled) break;
					processEvent(event);
				}
			} catch (e) {
				if ((e as Error).name !== 'AbortError' && !cancelled) {
					setError(e as Error);
				}
			}
		})();

		return () => {
			cancelled = true;
			controller.abort();
			abortRef.current = null;
			clearInterruptTimer();
		};
	}, [agentId, sessionId, scheduleUpdate, processEvent, audioManager, clearInterruptTimer]);

	/**
	 * Send a user message. Appends the message to the local list
	 * optimistically, then fires a ``POST /chat/`` trigger. Events
	 * arrive via the already-open SSE connection.
	 *
	 * The two-argument shape lets callers attach a separate
	 * "auto-context" payload — workspace cwd / git, recent turns, the
	 * available skills — that the backend injects into the LLM
	 * message (``internal``) without persisting it as a user-visible
	 * block (``display``). Passing nothing keeps the legacy behavior
	 * where ``input`` alone drives both channels.
	 *
	 * The third ``selectedSkills`` argument lets the host attach skill
	 * references for the visible chip row above the user bubble, plus
	 * the backend can re-derive its auto_context from the same ids if
	 * the autoContext payload wasn't supplied (some flows build the
	 * spec payload directly in ChatContent).
	 *
	 * @param content - The message content blocks (the user-typed part).
	 * @param autoContext - Optional implicit context blocks to prepend to
	 *   the LLM message but hide from the bubble.
	 * @param selectedSkills - Optional SlashItem[] the user attached via
	 *   the slash menu. Stored on message.metadata for render + forwarded
	 *   to backend as ``selected_skill_ids`` so bridge.js can build a fresh
	 *   skill context for the LLM.
	 */
	const send = useCallback(
		async (
			content: ContentBlock[],
			autoContext?: ContentBlock[],
			selectedSkills?: { id: string; name: string; display_name?: string | null }[],
		) => {
			if (!agentId) return;

			// No session yet — auto-create one so the user can send a
			// message into an empty conversation list / a bare ``/chat/:agent``
			// URL. notify the host so it can rewrite the URL to point at
			// the new id (a page reload after that lands the user back in
			// the conversation they just started). The trigger fires with
			// the new id directly, so the reply starts on the new session
			// even before the host's re-render has propagated the change.
			// Attach the picked-skill ids on message metadata so the bubble
			// can render a chip row above the user content. ``send_at`` gives
			// the backend a stable timestamp to fall back on if upstream
			// timestamps get dropped.
			const selectedSkillIds = (selectedSkills ?? []).map((s) => s.id);
			const userMsg = UserMsg({
				name: 'user',
				content,
				metadata: selectedSkillIds.length > 0
					? { selected_skill_ids: selectedSkillIds }
					: {},
			});
			// 触发请求与首个 SSE 事件之间可能有明显空窗。先进入 streaming，
			// 让消息区能立即呈现“思考中”，而不是等到模型已经开始输出。
			setPhase('streaming');
			let realSessionId = sessionId;
			if (!realSessionId) {
				// 点下发送的那一帧就显示：早先要等 create 一个 RTT 返回才
				// 追加，期间界面"毫无反应"，用户会重复点击或以为没发出去。
				msgsRef.current = [...msgsRef.current, userMsg];
				scheduleUpdate();
				try {
					// 切换落地前的多次首发共享同一个 create——连发两条不应
					// 长出两个会话，两条消息落进同一个新会话。
					if (!pendingCreateRef.current) {
						pendingCreateRef.current = sessionApi
							.create({
								agent_id: agentId,
								...optionsRef.current?.newSessionExtras?.(),
							})
							.then((res) => res.session_id);
					}
					realSessionId = await pendingCreateRef.current;
				} catch (e) {
					setError(e as Error);
					// create 失败：撤回这条乐观消息（toast 已由 client 弹出），
					// 并清掉 rejected promise，让下一条消息可以重新建会话。
					pendingCreateRef.current = null;
					msgsRef.current = msgsRef.current.filter((m) => m.id !== userMsg.id);
					scheduleUpdate();
					setPhase('idle');
					return;
				}
				// 先把用户消息追加进内存，再通知宿主改 URL —— 跳转触发的
				// 加载 effect 会走「接管」分支（freshlyCreated），不会把
				// 这条乐观消息抹掉。顺序反了消息就会凭空消失。
				optionsRef.current?.onSessionCreated?.(realSessionId);
			} else {
				msgsRef.current = [...msgsRef.current, userMsg];
				scheduleUpdate();
			}

			try {
				await chatApi.trigger({
					agent_id: agentId,
					session_id: realSessionId,
					input: userMsg,
					...(autoContext && autoContext.length > 0 ? { auto_context: autoContext } : {}),
					...(selectedSkillIds.length > 0
						? { selected_skill_ids: selectedSkillIds }
						: {}),
				});
			} catch (e) {
				setError(e as Error);
				// 请求未被服务端接收时不会有 REPLY_END，必须把乐观进入的
				// streaming 状态复位，避免“思考中”与停止按钮永久停留。
				setPhase('idle');
			}
		},
		[agentId, sessionId, scheduleUpdate],
	);

	/**
	 * Confirm or deny a tool call (human-in-the-loop). Fires a
	 * ``POST /chat/`` with a ``UserConfirmResultEvent``; events
	 * arrive via SSE.
	 *
	 * @param toolCall - The tool call block to confirm/deny.
	 * @param confirm - Whether the user confirmed.
	 * @param replyId - The reply id the tool call belongs to.
	 * @param rules - Optional permission rules to attach.
	 */
	const onUserConfirm = useCallback(
		async (
			toolCall: ToolCallBlock,
			confirm: boolean,
			replyId: string,
			rules?: ToolCallBlock['suggested_rules'],
		) => {
			if (!agentId || !sessionId) return;

			// Restore the ref so continuation events (no REPLY_START)
			// have a target.
			currentReplyRef.current = msgsRef.current.find((m) => m.id === replyId) ?? null;

			const event: UserConfirmResultEvent = {
				type: EventType.USER_CONFIRM_RESULT,
				id: crypto.randomUUID(),
				created_at: new Date().toISOString(),
				reply_id: replyId,
				confirm_results: [
					{ confirmed: confirm, tool_call: toolCall, rules: rules ?? null },
				],
			};

			try {
				await chatApi.trigger({
					agent_id: agentId,
					session_id: sessionId,
					input: event,
				});
			} catch (e) {
				setError(e as Error);
				throw e;
			}
		},
		[agentId, sessionId],
	);

	/**
	 * Answer (or cancel) the pending AskUserQuestion round. Posts a
	 * ``USER_QUESTION_ANSWER`` to ``/chat/`` — the backend wakes the
	 * parked run; the panel closes when the echoed
	 * ``user_question_answered`` event comes back through SSE (so other
	 * tabs / reconnects stay consistent).
	 */
	const answerQuestion = useCallback(
		async (
			entry: UserQuestionEntry,
			payload: {
				answers: Array<{ selected: string[]; other?: string }>;
				note?: string;
				cancelled?: boolean;
			},
		) => {
			if (!agentId || !sessionId) return;
			// Restore the ref so continuation events (no REPLY_START) have a target.
			currentReplyRef.current =
				msgsRef.current.find((m) => m.id === entry.reply_id) ?? null;
			try {
				const res = await chatApi.trigger({
					agent_id: agentId,
					session_id: sessionId,
					input: {
						type: 'USER_QUESTION_ANSWER',
						id: crypto.randomUUID(),
						created_at: new Date().toISOString(),
						reply_id: entry.reply_id,
						ask_id: entry.ask_id,
						answers: payload.answers,
						note: payload.note ?? '',
						cancelled: !!payload.cancelled,
					} as never,
				});
				// Stale (run already ended): close locally — the backend has
				// nothing left to wake, and no echoed event will arrive.
				if ((res as { status?: string })?.status === 'stale') {
					setUserQuestion((prev) => (prev?.ask_id === entry.ask_id ? null : prev));
				}
			} catch (e) {
				setError(e as Error);
				throw e;
			}
		},
		[agentId, sessionId],
	);

	/** Abort the current SSE connection. */
	const abort = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	/**
	 * Request interruption of the in-progress reply (running or parked
	 * on HITL). Optimistically moves ``phase`` to ``interrupting`` so
	 * the UI can disable the Stop button; the phase reverts to
	 * ``idle`` when the backend's terminating ``ReplyEndEvent``
	 * arrives via SSE (or after a 10s safety timeout, in case that
	 * event is lost).
	 *
	 * Backend contract:
	 * - 202: interrupt was accepted (cancel signal broadcast for a
	 *   running reply, or wakeup enqueued for a parked one). The
	 *   resulting ``ReplyEndEvent`` arrives through the SSE stream and
	 *   drives the phase transition.
	 * - Idle sessions are a silent no-op at the agent layer, so
	 *   spamming this callback is safe.
	 */
	const interrupt = useCallback(async () => {
		if (!agentId || !sessionId) return;
		// 用户主动打断：随后的 REPLY_END 是收尾，不触发完成提示音。
		interruptedRef.current = true;
		// Only escalate to ``interrupting`` if a reply is actually in
		// flight; if we're already idle (SSE completed just before the
		// click) leave the phase alone.
		setPhase((prev) => (prev === 'streaming' ? 'interrupting' : prev));
		clearInterruptTimer();
		interruptTimerRef.current = setTimeout(() => {
			interruptTimerRef.current = null;
			setPhase((prev) => (prev === 'interrupting' ? 'idle' : prev));
		}, INTERRUPT_TIMEOUT_MS);
		try {
			const res = await sessionApi.interrupt(sessionId, agentId);
			// Backend reports the target was already idle: the closing SSE
			// event may never come — revert immediately instead of waiting
			// out the 10s safety timer.
			if (res && res.interrupted === false) {
				clearInterruptTimer();
				setPhase((prev) => (prev === 'interrupting' ? 'idle' : prev));
			}
		} catch (e) {
			clearInterruptTimer();
			setPhase((prev) => (prev === 'interrupting' ? 'idle' : prev));
			setError(e as Error);
		}
	}, [agentId, sessionId, clearInterruptTimer]);

	/**
	 * Confirm or deny a tool call that a *team member* is awaiting,
	 * from this leader view (design §3.6 — backend routing).
	 *
	 * The result is POSTed to the **leader** session (the
	 * ``(agentId, sessionId)`` this hook is bound to), NOT the worker.
	 * The backend resolves ``reply_id`` → worker session via the
	 * leader's pending hash and forwards the event to the worker's
	 * continuation. The client never addresses the worker directly —
	 * ``entry.worker_*`` ids are used only for local dedup / clearing.
	 *
	 * @param entry - The pending subagent HITL entry being resolved.
	 * @param toolCall - The tool call block to confirm/deny.
	 * @param confirm - Whether the user confirmed.
	 * @param rules - Optional permission rules to attach.
	 */
	const onSubagentConfirm = useCallback(
		async (
			entry: SubagentHitlEntry,
			toolCall: ToolCallBlock,
			confirm: boolean,
			rules?: ToolCallBlock['suggested_rules'],
		) => {
			if (!agentId || !sessionId) return;

			const event: UserConfirmResultEvent = {
				type: EventType.USER_CONFIRM_RESULT,
				id: crypto.randomUUID(),
				created_at: new Date().toISOString(),
				reply_id: entry.reply_id, // worker's reply_id; backend maps it
				confirm_results: [
					{ confirmed: confirm, tool_call: toolCall, rules: rules ?? null },
				],
			};

			try {
				// Post to the leader front door — backend routes to the
				// worker session (§3.6). Do NOT address the worker here.
				await chatApi.trigger({
					agent_id: agentId,
					session_id: sessionId,
					input: event,
				});
			} catch (e) {
				setError(e as Error);
				// Rethrow so the card can re-enable itself and be retried.
				throw e;
			}

			// Drop only the call just answered — an entry can carry several
			// pending tool calls, and clearing the whole entry would take the
			// unanswered siblings' cards down with it. The backend's clear
			// event removes whatever is left.
			setSubagentHitl((prev) =>
				prev.flatMap((x) => {
					if (hitlKey(x) !== hitlKey(entry)) return [x];
					const remaining = (x.event.tool_calls ?? []).filter(
						(tc) => tc.id !== toolCall.id,
					);
					return remaining.length > 0
						? [{ ...x, event: { ...x.event, tool_calls: remaining } }]
						: [];
				}),
			);
		},
		[agentId, sessionId],
	);

	// 会话级系统提示（如模型切换条）由后端写进 display，但不经过事件流——
	// 本地时间线不会自己长出来。模型切换后由 ChatViewport 调用此函数，
	// 重新拉取持久化历史，把新提示条即时补进本地消息尾部。
	const reloadHistory = useCallback(async () => {
		if (!agentId || !sessionId) return;
		try {
			const { messages } = await sessionApi.messages(sessionId, agentId);
			// 合并策略：以服务器历史为准，但保留本地流式中未落盘的尾巴
			// （reply 进行中时服务器 display 还没有这条 assistant Msg）。
			// 简单可靠的做法：只在服务器比本地「多出尾部 system 消息」时追加。
			const local = msgsRef.current;
			const added = messages.filter((m) => m.role === 'system' && !local.some((x) => x.id === m.id));
			if (added.length) {
				// system 消息按 created_at 插入合适位置：仅当全部晚于本地最后一条时直接 append
				msgsRef.current = [...local, ...added];
				setMsgs([...msgsRef.current]);
			}
		} catch { /* 静默：下次 refetch 会补 */ }
	}, [agentId, sessionId]);

	const currentKey = agentId !== null && sessionId !== null ? `${agentId}:${sessionId}` : null;
	const ownsConversation = currentKey !== null && loadedKey === currentKey;
	const loading = currentKey !== null && !ownsConversation;
	// 空态（还没有会话）也要放行：那时 msgs 平时是空的，唯一非空的时刻是
	// send() 刚建完会话、把第一条消息乐观追加进内存的那段窗口——宿主还没
	// 把 sessionId 翻转过来（要等 URL/列表更新），此时旧门控会把这条消息
	// 藏起来，用户视角就是"发了消息但界面毫无反应"。
	const showConversation = currentKey === null || ownsConversation;

	return {
		msgs: showConversation ? msgs : [],
		loading,
		phase: showConversation ? phase : ('idle' as ReplyPhase),
		error: showConversation ? error : null,
		send,
		onUserConfirm,
		onSubagentConfirm,
		subagentHitl: showConversation ? subagentHitl : [],
		userQuestion: showConversation ? userQuestion : null,
		answerQuestion,
		abort,
		interrupt,
		reloadHistory,
	};
}
