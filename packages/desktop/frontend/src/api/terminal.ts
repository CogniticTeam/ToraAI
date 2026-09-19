import { client } from './client';

/** POST /terminal/create 的响应：终端会话句柄。 */
export interface TerminalSession {
	id: string;
	shell: string;
	cwd: string;
	pid: number;
}

/** GET /terminal/:id/stream 推来的三种帧：历史回放、实时输出、退出。 */
export type TerminalStreamEvent =
	| { type: 'data'; data: string }
	| { type: 'replay'; data: string }
	| { type: 'exit'; code: number | null };

export const terminalApi = {
	/** 起一个持久 shell（$SHELL -i，TERM=dumb），返回会话句柄。 */
	create: (cwd: string) => client.post<TerminalSession>('/terminal/create', { cwd }),

	/** 向终端写入输入（回车即 \n）。进程已退出返回 404 —— 静默，调用方自行处理。 */
	write: (id: string, data: string) =>
		client.post<{ status: string }>(`/terminal/${id}/write`, { data }, undefined, {
			silent: true,
		}),

	/** 结束终端（SIGTERM → 2s 后 SIGKILL 兜底）。 */
	kill: (id: string) =>
		client.post<{ status: string }>(`/terminal/${id}/kill`, undefined, undefined, {
			silent: true,
		}),

	/**
	 * 订阅终端输出流。用 fetch-SSE（而非原生 EventSource）以便带上
	 * X-User-ID 自定义头 —— 与 sessionApi.streamEvents 同一套路。
	 * 连上后先收到一帧 replay（历史回放，面板重开时恢复画面），
	 * 之后是实时 data 帧；进程退出时以一帧 exit 收尾。
	 */
	stream: async function* (
		id: string,
		signal?: AbortSignal,
	): AsyncGenerator<TerminalStreamEvent> {
		const res = await client.stream(`/terminal/${id}/stream`, { method: 'GET', signal });

		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const json = line.slice(6).trim();
						if (json) yield JSON.parse(json) as TerminalStreamEvent;
					}
					// 心跳注释帧（`:\n`）静默跳过。
				}
			}
		} finally {
			reader.releaseLock();
		}
	},
};
