import { Activity, Webhook } from 'lucide-react';
import { useState } from 'react';

import type { HooksView, TraceView } from '@/api';
import { PanelEmpty } from '@/components/panel/PanelEmpty';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';

interface TracePanelProps {
	traces: TraceView[];
	hooks: HooksView | null;
	loading: boolean;
	onRefresh: () => void;
	/** Fetches and returns the rendered timeline markdown for one run. */
	onOpenTrace: (id: string) => Promise<string>;
	/**
	 * Grants/revokes trust for the workspace's own `.cocode/hooks.json`.
	 * Omitted when there is no workspace to trust.
	 */
	onTrustProjectHooks?: (trust: boolean) => void;
}

/** A one-line summary of a run: when, how long, how much work, why it ended. */
function summarize(t: TraceView, zh: boolean): string {
	const when = new Date(t.startedAt).toLocaleString(zh ? 'zh-CN' : 'en-US', {
		month: 'numeric',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	const secs = t.durationMs != null ? `${(t.durationMs / 1000).toFixed(1)}s` : '—';
	return zh ? `${when} · ${secs} · ${t.turns} 轮 · ${t.tools} 次工具` : `${when} · ${secs} · ${t.turns} turns · ${t.tools} tools`;
}

/**
 * Run history plus the hook table.
 *
 * These two share a panel because they answer the same question from two
 * sides: "why did it do that?" — the trace shows what the agent actually
 * sent and did, the hook table shows which rules were allowed to interfere.
 * A hook that silently failed is also a perfectly good explanation, which is
 * why `errors` from the hook loader is surfaced verbatim.
 *
 * @param traces - Recorded runs, newest first from the server.
 * @returns The panel body (no header chrome — `Panel` draws that).
 */
export function TracePanel({
	traces,
	hooks,
	loading,
	onRefresh,
	onOpenTrace,
	onTrustProjectHooks,
}: TracePanelProps) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const [openId, setOpenId] = useState<string | null>(null);
	const [markdown, setMarkdown] = useState('');
	const [busy, setBusy] = useState(false);

	const open = async (id: string) => {
		if (openId === id) {
			setOpenId(null);
			return;
		}
		setOpenId(id);
		setBusy(true);
		try {
			setMarkdown(await onOpenTrace(id));
		} catch (e) {
			setMarkdown(`${zh ? '读取失败' : 'Read failed'}: ${(e as Error)?.message ?? String(e)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-1 flex-col gap-3 min-h-0">
			{/* ---- hooks ---- */}
			<section className="flex flex-col gap-1.5">
				<div className="flex items-center gap-x-1.5 px-1 text-xs font-medium text-muted-foreground">
					<Webhook className="size-3.5" />
					{zh ? '钩子' : 'Hooks'}
					<span className="ml-auto font-normal">
						{hooks?.rows.length ? (zh ? `${hooks.rows.length} 个生效` : `${hooks.rows.length} active`) : (zh ? '未配置' : 'Not configured')}
					</span>
				</div>
				{hooks?.projectHooksPresent && !hooks.projectHooksTrusted ? (
					<div className="rounded-md border border-amber-500 bg-amber-50 dark:bg-amber-950 px-2 py-1.5 text-xs">
						<p>
							{zh ? '工作目录里有 .cocode/hooks.json，但未信任项目钩子 —— 已跳过执行。项目钩子来自仓库内容，信任前请先看过里面的命令。' : 'This workspace contains .cocode/hooks.json, but project hooks are not trusted and were skipped. Review repository commands before trusting them.'}
						</p>
						{onTrustProjectHooks ? (
							<Button
								variant="outline"
								size="sm"
								className="mt-1.5"
								onClick={() => onTrustProjectHooks(true)}
							>
								{zh ? '信任此目录' : 'Trust this workspace'}
							</Button>
						) : null}
					</div>
				) : null}
				{hooks?.projectHooksTrusted && hooks.projectHooksPresent ? (
					<div className="flex items-center gap-x-2 text-xs text-muted-foreground">
						<span>{zh ? '已信任此目录的项目钩子' : 'Project hooks trusted for this workspace'}</span>
						{onTrustProjectHooks ? (
							<Button variant="ghost" size="sm" onClick={() => onTrustProjectHooks(false)}>
								{zh ? '撤销信任' : 'Revoke trust'}
							</Button>
						) : null}
					</div>
				) : null}
				{(hooks?.rows ?? []).map((h, i) => (
					// Keyed by position: the same command may legitimately be
					// registered for two events with identical fields.
					<li key={i} className="list-none rounded-md border px-2 py-1.5 text-xs">
						<div className="flex items-center gap-x-2">
							<Badge variant="secondary">{h.event}</Badge>
							<Badge variant="outline">{h.matcher}</Badge>
							<span className="ml-auto text-muted-foreground">{h.source}</span>
						</div>
						<div className="mt-1 truncate font-mono text-muted-foreground" title={h.command}>
							{h.command}
						</div>
					</li>
				))}
				{(hooks?.errors ?? []).map((e, i) => (
					<p key={i} className="text-xs text-rose-600 dark:text-rose-400">
						✗ {e}
					</p>
				))}
			</section>

			{/* ---- traces ---- */}
			<section className="flex flex-1 flex-col gap-1.5 min-h-0">
				<div className="flex items-center gap-x-1.5 px-1 text-xs font-medium text-muted-foreground">
					<Activity className="size-3.5" />
									{zh ? '运行记录' : 'Run history'}
									<span className="ml-auto font-normal">{loading ? (zh ? '读取中…' : 'Loading…') : (zh ? `${traces.length} 次` : `${traces.length} runs`)}</span>
					<Button variant="ghost" size="sm" onClick={onRefresh}>
						{zh ? '刷新' : 'Refresh'}
					</Button>
				</div>

				{traces.length === 0 ? (
					<PanelEmpty
						icon={Activity}
						title={zh ? '还没有运行记录' : 'No run history yet'}
						description={zh ? '每次运行都会写一份可回放的时间线（发出去的请求、工具调用、权限决策、上下文压缩）。排障时先看它。' : 'Each run records a replayable timeline of requests, tool calls, permission decisions, and context compaction.'}
					/>
				) : (
					<ul className="flex flex-col gap-1.5">
						{traces.map((t) => (
							<li key={t.id} className="rounded-md border">
								<button
									type="button"
									className="flex w-full items-center gap-x-2 px-2 py-1.5 text-left text-xs hover:bg-muted"
									onClick={() => void open(t.id)}
								>
									<span className="truncate">{summarize(t, zh)}</span>
									<Badge
										variant={t.reason === 'completed' ? 'secondary' : 'outline'}
										className="ml-auto shrink-0"
									>
										{t.reason}
									</Badge>
								</button>
								{openId === t.id ? (
									<pre className="max-h-80 overflow-auto border-t bg-muted px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
										{busy ? (zh ? '读取中…' : 'Loading…') : markdown}
									</pre>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
