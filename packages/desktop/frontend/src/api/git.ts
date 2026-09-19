import { client } from './client';

/** 分支：name / current / sha / upstream / ahead / behind / subject */
export interface GitBranch {
	name: string;
	current: boolean;
	sha: string;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	subject: string;
}

/** 工作树：path / head / branch / detached / bare / locked / prunable */
export interface GitWorktree {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	prunable: boolean;
}

/** 暂存区文件：path + git status XY 码（M/A/D/R/C 等） */
export interface GitFileEntry {
	path: string;
	status: string;
}

export interface GitStatusFiles {
	staged: GitFileEntry[];
	unstaged: GitFileEntry[];
	untracked: string[];
}

export interface GitCommit {
	sha: string;
	subject: string;
	author: string;
	relative: string;
}

export const gitApi = {
	branches: (sessionId: string) =>
		client.get<{ branches: GitBranch[] }>('/git/branches', { session_id: sessionId }, { silent: true }),

	createBranch: (sessionId: string, name: string, from?: string) =>
		client.post<{ status: string }>('/git/branches', { session_id: sessionId, name, from }),

	switchBranch: (sessionId: string, name: string) =>
		client.post<{ status: string; git: unknown }>(`/git/branches/${encodeURIComponent(name)}/switch`, {
			session_id: sessionId,
		}),

	deleteBranch: (sessionId: string, name: string, force = false) =>
		client.delete<{ status: string }>(`/git/branches/${encodeURIComponent(name)}`, {
			session_id: sessionId,
			...(force ? { force: '1' } : {}),
		}),

	worktrees: (sessionId: string) =>
		client.get<{ worktrees: GitWorktree[] }>('/git/worktrees', { session_id: sessionId }, { silent: true }),

	createWorktree: (sessionId: string, path: string, branch: string, from?: string) =>
		client.post<{ status: string }>('/git/worktrees', { session_id: sessionId, path, branch, from }),

	removeWorktree: (sessionId: string, path: string, force = false) =>
		client.delete<{ status: string }>('/git/worktrees', {
			session_id: sessionId,
			path,
			...(force ? { force: '1' } : {}),
		}),

	stage: (sessionId: string, paths: string[] = []) =>
		client.post<{ status: string }>('/git/stage', { session_id: sessionId, paths }),

	unstage: (sessionId: string, paths: string[] = []) =>
		client.post<{ status: string }>('/git/unstage', { session_id: sessionId, paths }),

	statusFiles: (sessionId: string) =>
		client.get<GitStatusFiles>('/git/status-files', { session_id: sessionId }, { silent: true }),

	commit: (sessionId: string, message: string) =>
		client.post<{ status: string; git: unknown }>('/git/commit', { session_id: sessionId, message }),

	log: (sessionId: string, limit = 20) =>
		client.get<{ commits: GitCommit[] }>(
			'/git/log',
			{ session_id: sessionId, limit: String(limit) },
			{ silent: true },
		),
};
