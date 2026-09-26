import { ApiError, client, getBaseUrl, getUserId } from './client';
import type { UploadProgress } from './knowledgeBase';
import type {
	AddFromLibraryResponse,
	AddSkillRequest,
	DirectoryListing,
	WorkspaceStatus,
	MCPClient,
	MCPClientStatus,
	Skill,
} from './types';

export interface UploadOptions {
	/** Fired with byte-level progress while the body is streamed. */
	onProgress?: (progress: UploadProgress) => void;
	/** Aborts the upload; rejects with a `DOMException` named `AbortError`. */
	signal?: AbortSignal;
}

/** One snapshot of the workspace taken before a turn that could write. */
export interface CheckpointView {
	/** Unique timeline node id (new format) — equals `turn` for legacy checkpoints. */
	id: number;
	/** Logical agent turn number when this snapshot was taken. */
	turn: number;
	/** Parent node id in the timeline; `null` for the root. Enables branching. */
	parent: number | null;
	at: number;
	fileCount: number;
	bytes?: number;
	label?: string | null;
	/** True when the workspace currently reflects this node (after a restore). */
	current?: boolean;
}

/** One user-authored slash command (`~/.cocode/commands/*.md`). */
export interface UserCommand {
	name: string;
	description: string;
	argument_hint?: string;
	body: string;
	source: 'user' | 'project';
}

/** One configured lifecycle hook. */
export interface HookRow {
	event: string;
	matcher: string;
	command: string;
	timeout: number;
	source: string;
}

export interface HooksView {
	rows: HookRow[];
	errors: string[];
	paths: string[];
	cwd: string | null;
	enabled?: boolean;
	projectHooksPresent: boolean;
	projectHooksTrusted: boolean;
}

/**
 * XHR-based folder upload — `fetch` surfaces no byte-level send
 * progress, so anything driving a progress bar has to use XHR.
 *
 * The manifest rides alongside the parts because the server builds a
 * tar as they arrive, and a tar header needs each member's size before
 * its bytes — which a multipart part does not declare.
 */
function uploadSkillXhr(
	agentId: string,
	sessionId: string,
	files: File[],
	options: UploadOptions = {},
): Promise<void> {
	const { onProgress, signal } = options;
	const formData = new FormData();
	formData.append(
		'manifest',
		JSON.stringify({
			entries: files.map((file) => ({
				path: file.webkitRelativePath || file.name,
				size: file.size,
			})),
		}),
	);
	for (const file of files) formData.append('files', file);

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}

		const xhr = new XMLHttpRequest();
		const url = new URL('/workspace/skill/upload', getBaseUrl());
		url.searchParams.set('agent_id', agentId);
		url.searchParams.set('session_id', sessionId);
		xhr.open('POST', url.toString(), true);
		xhr.setRequestHeader('X-User-ID', getUserId());

		const onAbort = () => xhr.abort();
		signal?.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => signal?.removeEventListener('abort', onAbort);

		if (xhr.upload && onProgress) {
			xhr.upload.onprogress = (e) => {
				onProgress({
					loaded: e.loaded,
					total: e.lengthComputable ? e.total : 0,
				});
			};
		}

		xhr.onload = () => {
			cleanup();
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
				return;
			}
			let detail = xhr.responseText || xhr.statusText;
			try {
				const json = JSON.parse(xhr.responseText) as { detail?: unknown };
				if (typeof json.detail === 'string') detail = json.detail;
				else if (json.detail !== undefined) detail = JSON.stringify(json.detail);
			} catch {
				// keep raw text
			}
			reject(new ApiError(xhr.status, detail));
		};
		xhr.onerror = () => {
			cleanup();
			reject(new ApiError(0, 'Network error'));
		};
		xhr.onabort = () => {
			cleanup();
			reject(new DOMException('Aborted', 'AbortError'));
		};

		xhr.send(formData);
	});
}

export const workspaceApi = {
	/**
	 * List one directory level inside the session's workspace.
	 *
	 * `path` may be absolute or relative to the workspace root; empty
	 * lists the root itself. Not confined to the root — for a sandboxed
	 * backend the reachable filesystem is the sandbox, and for a local
	 * one the caller is already trusted with the host. The response
	 * echoes the resolved absolute path.
	 */
	directories: (agentId: string, sessionId: string, path = '') =>
		client.get<DirectoryListing>('/workspace/directories', {
			agent_id: agentId,
			session_id: sessionId,
			path,
		}),

	/**
	 * Where the session is pointed, plus the git state of that place.
	 *
	 * `silent` because this is fetched on the UI's own schedule: git
	 * being unavailable is an ordinary answer, not something to raise a
	 * toast over.
	 */
	status: (agentId: string, sessionId: string | null, cwd: string | null = null) =>
		client.get<WorkspaceStatus>(
			'/workspace/status',
			{ agent_id: agentId, ...(sessionId ? { session_id: sessionId } : cwd ? { cwd } : {}) },
			{ silent: true },
		),

	mcp: {
		list: (agentId: string, sessionId: string) =>
			client.get<MCPClientStatus[]>('/workspace/mcp', {
				agent_id: agentId,
				session_id: sessionId,
			}),

		add: (agentId: string, sessionId: string, mcp: MCPClient) =>
			client.post<void>('/workspace/mcp', mcp, { agent_id: agentId, session_id: sessionId }),

		/**
		 * Puts MCPs the user has already installed into this workspace.
		 * Ids, not configs — the rendered config never leaves the server,
		 * so the client has no way to reconstruct one.
		 */
		addFromLibrary: (agentId: string, sessionId: string, mcpIds: string[]) =>
			client.post<AddFromLibraryResponse>(
				'/workspace/mcp/from-library',
				{ mcp_ids: mcpIds },
				{ agent_id: agentId, session_id: sessionId },
			),

		remove: (mcpName: string, agentId: string, sessionId: string) =>
			client.delete(`/workspace/mcp/${mcpName}`, {
				agent_id: agentId,
				session_id: sessionId,
			}),
	},

	skill: {
		list: (agentId: string, sessionId: string) =>
			client.get<Skill[]>('/workspace/skill', { agent_id: agentId, session_id: sessionId }),

		/**
		 * @deprecated The path is resolved on the server. Use `upload`
		 * for a local folder or `addFromLibrary` for an installed skill.
		 */
		add: (agentId: string, sessionId: string, body: AddSkillRequest) =>
			client.post<void>('/workspace/skill', body, {
				agent_id: agentId,
				session_id: sessionId,
			}),

		/** Uploads a picked folder as a skill, reporting send progress. */
		upload: (agentId: string, sessionId: string, files: File[], options: UploadOptions = {}) =>
			uploadSkillXhr(agentId, sessionId, files, options),

		/** Installs skills the user already has, by library record id. */
		addFromLibrary: (agentId: string, sessionId: string, skillIds: string[]) =>
			client.post<AddFromLibraryResponse>(
				'/workspace/skill/from-library',
				{ skill_ids: skillIds },
				{ agent_id: agentId, session_id: sessionId },
			),

		remove: (skillName: string, agentId: string, sessionId: string) =>
			client.delete(`/workspace/skill/${skillName}`, {
				agent_id: agentId,
				session_id: sessionId,
			}),
	},

	/**
	 * CoCode extensions that the agent's own runtime backs: checkpoints,
	 * change preview, hooks and slash commands.
	 *
	 * Everything here is `silent` — these are panels and menus, and a
	 * backend that predates them (or a session with no workspace yet)
	 * answering 4xx is an ordinary state, not a toast.
	 */
	cocode: {
		checkpoints: (sessionId: string) =>
			client.get<{ checkpoints: CheckpointView[] }>(
				`/sessions/${sessionId}/checkpoints`,
				{},
				{ silent: true },
			),

		/** Rolls the workspace back to just before `turn` (files are written back). */
		restoreCheckpoint: (sessionId: string, turn: number) =>
			client.post<{ status: string; restored: number; deleted: number }>(
				`/sessions/${sessionId}/checkpoints/${turn}/restore`,
				{},
			),

		diff: (agentId: string, sessionId: string, opts: { staged?: boolean; path?: string } = {}) =>
			client.get<{ diff: string; root?: string; error?: string; error_code?: 'not_git_repository' | 'git_unavailable' | 'git_diff_failed' }>(
				'/workspace/diff',
				{
					agent_id: agentId,
					session_id: sessionId,
					...(opts.staged ? { staged: '1' } : {}),
					...(opts.path ? { path: opts.path } : {}),
				},
				{ silent: true },
			),

		hooks: (sessionId: string) =>
			client.get<HooksView>('/hooks', { session_id: sessionId }, { silent: true }),

		/** Grants or revokes trust for the workspace's own `.cocode/hooks.json`. */
		trustProjectHooks: (cwd: string, trust: boolean) =>
			client.post<{ status: string; trusted: boolean; trustProjectHooksFor: string[] }>(
				'/hooks/trust',
				{ cwd, trust },
			),

		commands: (sessionId: string) =>
			client.get<UserCommand[]>('/commands', { session_id: sessionId }, { silent: true }),

		indexStats: (sessionId: string) =>
			client.get<{
				cwd: string;
				semantic: { indexed: boolean; files?: number; tokens?: number; builtAt?: number };
				symbols: { files?: number; count?: number };
			}>('/admin/index', { session_id: sessionId }, { silent: true }),

		/** Rebuilds the symbol + semantic indexes (a few hundred ms on a mid-size repo). */
		rebuildIndex: (sessionId: string) =>
			client.post<{ status: string }>('/admin/index', {}, { session_id: sessionId }),
	},
};
