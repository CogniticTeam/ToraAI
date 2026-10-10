import { client } from './client';
import type {
	AgentEvent,
	CreateSessionRequest,
	CreateSessionResponse,
	InterruptSessionResponse,
	SessionListResponse,
	SessionRecord,
	UpdateSessionRequest,
	Msg,
} from './types';

export interface MessagesResponse {
	messages: Msg[];
	is_running: boolean;
	has_more: boolean;
}

export type SessionStreamFrame =
	| { kind: 'status'; mode: 'initial' | 'resume' | 'reset'; streamId: string }
	| { kind: 'event'; cursor: string | null; event: AgentEvent };

/**
 * Sessions this tab created and has not opened yet.
 *
 * A session created here cannot have any history, so asking the server
 * for it is a guaranteed-empty round trip — and one that paints a
 * loading state over a conversation the user is about to start.
 *
 * Entries are consumed on first read: once the session has been opened,
 * anything written to it afterwards (a scheduled run, a team member)
 * must be fetched normally.
 */
const freshlyCreated = new Set<string>();

/**
 * Whether `sessionId` was created by this tab and not yet opened.
 * Consumes the flag, so a second call for the same id returns false.
 *
 * @param sessionId - The session about to be opened.
 * @returns True when its history can safely be assumed empty.
 */
export function takeFreshlyCreated(sessionId: string): boolean {
	return freshlyCreated.delete(sessionId);
}

/**
 * 非消费式查看：`sessionId` 是否由本 tab 创建且尚未被接管。
 *
 * 供页面外层在渲染期判断「这个 URL 指向的会话一定存在、且没有可拉的
 * 历史」——列表缓存还没把它插进来时也敢先行切换，SSE 与消息接管不必
 * 等列表 refetch（否则用户会卡在"发了消息但没反应"的空窗里）。
 * 与 `takeFreshlyCreated` 不同，可安全地在同一 id 上反复调用。
 */
export function hasFreshlyCreated(sessionId: string): boolean {
	return freshlyCreated.has(sessionId);
}

export const sessionApi = {
  preview: (sessionId: string, agentId: string, replyId: string) => client.post<{kind: 'html' | 'server';url: string;entry?: string}>(`/sessions/${sessionId}/preview`, {reply_id:replyId}, {agent_id:agentId}, {silent:true}),
	list: (agentId: string) => client.get<SessionListResponse>('/sessions/', { agent_id: agentId }),

	create: async (body: CreateSessionRequest) => {
		const res = await client.post<CreateSessionResponse>('/sessions/', body);
		freshlyCreated.add(res.session_id);
		return res;
	},

	/**
	 * Update a session's configuration.
	 *
	 * Returns 409 while a chat run holds the session — the agent
	 * snapshots its configuration at run start, so the change could not
	 * apply to the reply in flight. Pass `silent` for automatic writes
	 * the user did not initiate, where a toast would be noise.
	 */
	update: (
		sessionId: string,
		agentId: string,
		body: UpdateSessionRequest,
		options?: { silent?: boolean },
	) =>
		client.patch<SessionRecord>(`/sessions/${sessionId}`, body, { agent_id: agentId }, options),

	delete: (sessionId: string, agentId: string) =>
		client.delete(`/sessions/${sessionId}`, { agent_id: agentId }),

	/**
	 * Request interruption of an in-progress reply (running or parked).
	 *
	 * Backend contract:
	 * - 202 Accepted → returns `InterruptSessionResponse`; the cancel
	 *   signal was broadcast (running) or a wakeup-interrupt was
	 *   enqueued (parked). Idempotent: an idle target is a silent
	 *   no-op at the agent layer.
	 * - 404 Not Found → the session does not exist.
	 */
	interrupt: (sessionId: string, agentId: string) =>
		client.post<InterruptSessionResponse>(`/sessions/${sessionId}/interrupt`, null, {
			agent_id: agentId,
		}),

	messages: (sessionId: string, agentId: string, params?: { before?: string; limit?: number }) =>
		client.get<MessagesResponse>(`/sessions/${sessionId}/messages`, {
			agent_id: agentId,
			...(params?.before != null && { before: params.before }),
			...(params?.limit != null && { limit: String(params.limit) }),
		}),

	/**
	 * Subscribe to a session's live event stream via SSE.
	 *
	 * Opens a long-lived ``GET /sessions/{sid}/stream`` connection and
	 * yields status and sequenced AgentEvent frames as they arrive. The connection stays
	 * open until the caller aborts via the ``signal`` or closes the
	 * generator.
	 *
	 * Uses fetch-based SSE (not native ``EventSource``) so the
	 * ``X-User-ID`` custom header is sent.
	 *
	 * @param sessionId - The session to subscribe to.
	 * @param agentId - The agent that owns the session.
	 * @param signal - Optional abort signal to close the connection.
	 * @returns An async generator yielding ``AgentEvent`` objects.
	 */
	streamEvents: async function* (
		sessionId: string,
		agentId: string,
		signal?: AbortSignal,
		afterCursor?: string | null,
	): AsyncGenerator<SessionStreamFrame> {
		const res = await client.stream(`/sessions/${sessionId}/stream`, {
			method: 'GET',
			params: { agent_id: agentId, ...(afterCursor ? { after_cursor: afterCursor } : {}) },
			signal,
			silent: true,
		});

		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				let boundary: number;
				while ((boundary = buffer.indexOf('\n\n')) >= 0) {
					const lines = buffer.slice(0, boundary).split('\n');
					buffer = buffer.slice(boundary + 2);
					const status = lines.find((line) => line.startsWith(': stream-status '));
					if (status) {
						try {
							const value = JSON.parse(status.slice(16)) as { mode: 'initial' | 'resume' | 'reset'; streamId: string };
							if (value.mode === 'initial' || value.mode === 'resume' || value.mode === 'reset') {
								yield { kind: 'status', mode: value.mode, streamId: value.streamId };
							}
						} catch { /* malformed status: next reconnect will refresh history */ }
						continue;
					}
					const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
					if (!data.length) continue;
					const cursor = lines.find((line) => line.startsWith('id: '))?.slice(4) ?? null;
					try { yield { kind: 'event', cursor, event: JSON.parse(data.join('\n')) as AgentEvent }; }
					catch { /* malformed frame is isolated from the rest of the stream */ }
				}
			}
		} finally {
			try { await reader.cancel(); } catch { /* stream may already be closed */ }
			reader.releaseLock();
		}
	},
};
