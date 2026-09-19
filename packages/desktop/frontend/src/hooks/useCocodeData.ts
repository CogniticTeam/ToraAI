import { useCallback, useEffect, useRef, useState } from 'react';

import { workspaceApi } from '@/api';
import type { CheckpointView, HooksView, TraceView, UserCommand } from '@/api';

/**
 * Data backing the CoCode-only panels: checkpoints (rollback), the working
 * tree diff, the run traces, the hook table and the user's slash commands.
 *
 * Grouped into one hook because they share a lifetime and a trigger — all
 * five are scoped to a session's working directory, and all five change
 * when (a) the session moves, or (b) a reply finishes (the agent may have
 * written files, added a checkpoint, or run a hook). Polling none of them
 * keeps a chat that is doing nothing from running git and reading index
 * files on a timer.
 *
 * @param agentId - Agent owning the session; `null` clears everything.
 * @param sessionId - The session to report on; `null` clears everything.
 * @param cwd - The session's working directory. Not read here — it is a
 *   dependency so that moving the session refetches.
 * @returns The five datasets plus their loading flags and refreshers.
 */
export function useCocodeData(
	agentId: string | null,
	sessionId: string | null,
	cwd: string | null,
) {
	const [checkpoints, setCheckpoints] = useState<CheckpointView[]>([]);
	const [diff, setDiff] = useState('');
	const [diffError, setDiffError] = useState<string | null>(null);
	const [hooks, setHooks] = useState<HooksView | null>(null);
	const [commands, setCommands] = useState<UserCommand[]>([]);
	const [traces, setTraces] = useState<TraceView[]>([]);
	const [loading, setLoading] = useState(false);
	// Only the newest request may write: a slow `git diff` on a big tree can
	// land after the user has already restored a checkpoint.
	const reqId = useRef(0);

	const refresh = useCallback(async () => {
		const id = ++reqId.current;
		if (!sessionId) {
			setCheckpoints([]);
			setDiff('');
			setDiffError(null);
			setHooks(null);
			setCommands([]);
			setTraces([]);
			return;
		}
		setLoading(true);
		// All five in parallel; each is independently allowed to fail.
		const [cp, df, hk, cm, tr] = await Promise.all([
			workspaceApi.cocode.checkpoints(sessionId).catch(() => null),
			agentId
				? workspaceApi.cocode.diff(agentId, sessionId).catch(() => null)
				: Promise.resolve(null),
			workspaceApi.cocode.hooks(sessionId).catch(() => null),
			workspaceApi.cocode.commands(sessionId).catch(() => null),
			workspaceApi.cocode.traces(sessionId).catch(() => null),
		]);
		if (id !== reqId.current) return;
		if (cp) setCheckpoints(cp.checkpoints ?? []);
		if (df) {
			setDiff(df.diff ?? '');
			setDiffError(df.error ?? null);
		}
		if (hk) setHooks(hk);
		if (cm) setCommands(Array.isArray(cm) ? cm : []);
		if (tr) setTraces(tr.traces ?? []);
		setLoading(false);
		// `agentId`/`cwd` are read only as change triggers.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentId, sessionId, cwd]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/**
	 * Roll the workspace back to just before `turn`.
	 *
	 * Refreshes afterwards because the rollback rewrites files — the diff
	 * panel in particular would otherwise keep showing the version that no
	 * longer exists on disk.
	 */
	const restoreCheckpoint = useCallback(
		async (turn: number) => {
			if (!sessionId) return null;
			const res = await workspaceApi.cocode.restoreCheckpoint(sessionId, turn);
			void refresh();
			return res;
		},
		[sessionId, refresh],
	);

	/** Grant/revoke trust for the workspace's own `.cocode/hooks.json`. */
	const setProjectHooksTrusted = useCallback(
		async (targetCwd: string, trust: boolean) => {
			const res = await workspaceApi.cocode.trustProjectHooks(targetCwd, trust);
			void refresh();
			return res;
		},
		[refresh],
	);

	/** Fetches the human-readable timeline for one run (renders in the panel). */
	const openTrace = useCallback(
		async (id: string) => {
			const res = await workspaceApi.cocode.traceMarkdown(id);
			return res.markdown;
		},
		[],
	);

	return {
		checkpoints,
		diff,
		diffError,
		hooks,
		commands,
		traces,
		loading,
		refresh,
		restoreCheckpoint,
		setProjectHooksTrusted,
		openTrace,
	};
}
