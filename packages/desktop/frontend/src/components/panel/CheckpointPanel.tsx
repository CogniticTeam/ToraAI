// 检查点时间线（升级版）
//
// 与旧版扁平列表的区别：
//   · 垂直时间线可视化：每个节点是时间线上的一个圆点
//   · 当前位置标记：回滚后哪个节点是「工作区当前状态」一目了然
//   · 分支标记：回滚到旧节点后继续快照会形成分支，分叉点有图标
//   · 节点间差异：显示相对父节点的文件数变化（+N/-N）
//
// 数据来自 listCheckpoints（每个节点带 id / turn / parent / current）。

import { GitBranch, History, RotateCcw, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { CheckpointView } from '@/api';
import { PanelEmpty } from '@/components/panel/PanelEmpty';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';

interface CheckpointPanelProps {
	checkpoints: CheckpointView[];
	loading: boolean;
	/** Rolls the workspace back to the node with this id. */
	onRestore: (id: number) => Promise<unknown>;
	onRefresh: () => void;
}

/** "3 分钟前" / "2 小时前" */
function ago(at: number, zh: boolean): string {
	const m = Math.floor((Date.now() - at) / 60000);
	if (m < 1) return zh ? '刚刚' : 'just now';
	if (m < 60) return zh ? `${m} 分钟前` : `${m} min ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return zh ? `${h} 小时前` : `${h} hr ago`;
	return zh ? `${Math.floor(h / 24)} 天前` : `${Math.floor(h / 24)} days ago`;
}

function fmtTime(at: number): string {
	return new Date(at).toLocaleString('zh-CN', {
		month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
	});
}

export function CheckpointPanel({ checkpoints, loading, onRestore, onRefresh }: CheckpointPanelProps) {
	const { i18n } = useTranslation();
	const zh = i18n.language.startsWith('zh');
	const [confirming, setConfirming] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	// 按 at 降序（新→旧），便于从上往下读时间线
	const sorted = useMemo(() => [...checkpoints].sort((a, b) => (b.at || 0) - (a.at || 0)), [checkpoints]);
	const byId = useMemo(() => new Map(checkpoints.map((c) => [c.id, c])), [checkpoints]);

	const restore = async (id: number) => {
		setBusy(true);
		setNote(null);
		try {
			await onRestore(id);
			setNote(zh ? '已回到该检查点，后续改动将形成新分支' : 'Restored this checkpoint. Further changes will create a new branch.');
			onRefresh();
		} catch (e) {
			setNote(`${zh ? '回滚失败' : 'Rollback failed'}: ${(e as Error)?.message ?? String(e)}`);
		} finally {
			setBusy(false);
			setConfirming(null);
		}
	};

	// 计算每个节点相对父节点的文件数变化
	const delta = (cp: CheckpointView): number | null => {
		if (cp.parent == null) return null;
		const p = byId.get(cp.parent);
		if (!p) return null;
		return cp.fileCount - p.fileCount;
	};

	// 判断是否是分支点：parent 不是时间线上紧邻的更旧节点
	const isBranch = (cp: CheckpointView, idx: number): boolean => {
		if (cp.parent == null) return false;
		const nextOlder = sorted[idx + 1];
		return nextOlder ? cp.parent !== nextOlder.id : false;
	};

	return (
		<div className="flex flex-1 flex-col gap-2 min-h-0">
			<div className="flex items-center justify-between gap-x-2 px-1 py-1 text-xs text-muted-foreground">
				<span>{busy ? (zh ? '正在回滚…' : 'Rolling back…') : loading ? (zh ? '读取中…' : 'Loading…') : (zh ? `共 ${sorted.length} 个节点` : `${sorted.length} checkpoints`)}</span>
				<Button variant="ghost" size="sm" onClick={onRefresh} disabled={busy}>{zh ? '刷新' : 'Refresh'}</Button>
			</div>

			{note ? (
				<div className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs">{note}</div>
			) : null}

			{sorted.length === 0 ? (
				<PanelEmpty
					icon={History}
					title={zh ? '还没有检查点' : 'No checkpoints yet'}
					description={zh ? '每一轮出现写入或执行类工具调用之前，CoCode 都会先给工作目录拍一张快照。改动出问题时可以回到任意一轮之前，回滚后继续工作会形成时间线分支。' : 'CoCode snapshots the workspace before write or execution tools. Restore any earlier point and continue on a new timeline branch.'}
				/>
			) : (
				<div className="relative pl-5">
					{/* 时间线竖线 */}
					<div className="absolute left-[7px] top-1 bottom-1 w-px bg-border" />
					<ul className="flex flex-col gap-1">
						{sorted.map((cp, idx) => {
							const d = delta(cp);
							const branched = isBranch(cp, idx);
							return (
								<li key={cp.id} className="relative">
									{/* 节点圆点 */}
									<span
										className={
											'absolute -left-[18px] top-1.5 size-3.5 rounded-full border-2 ' +
											(cp.current
												? 'border-primary bg-primary'
												: branched
													? 'border-amber-500 bg-amber-500'
													: 'border-border bg-background')
										}
									/>
									<div
										className={
											'rounded-md border px-2 py-1.5 ' +
											(cp.current ? 'border-primary/50 bg-primary/5' : '')
										}
									>
										<div className="flex items-center gap-x-2 text-sm">
							<span className="font-medium">{zh ? `第 ${cp.turn} 轮之前` : `Before turn ${cp.turn}`}</span>
											{branched ? (
												<Badge variant="outline" className="gap-x-1 text-[10px]">
									<GitBranch className="size-3" /> {zh ? '分支' : 'Branch'}
												</Badge>
											) : null}
							{cp.current ? <Badge variant="default" className="text-[10px]">{zh ? '当前' : 'Current'}</Badge> : null}
							<Badge variant="secondary">{cp.fileCount} {zh ? '文件' : 'files'}</Badge>
											{d != null && d !== 0 ? (
												<span className={'text-[10px] ' + (d > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>
													{d > 0 ? `+${d}` : d}
												</span>
											) : null}
											<span className="ml-auto text-xs text-muted-foreground" title={fmtTime(cp.at)}>
												{ago(cp.at, zh)}
											</span>
										</div>
										{cp.label ? <div className="mt-0.5 text-xs text-muted-foreground">{cp.label}</div> : null}
										<div className="mt-1 flex items-center gap-x-2 border-t pt-1">
											{confirming === cp.id ? (
												<>
													<ShieldAlert className="size-3.5 shrink-0 text-amber-500" />
									<span className="text-xs">{zh ? '会覆盖这之后的所有改动并删掉新增文件，确定？' : 'This will overwrite later changes and delete new files. Continue?'}</span>
													<div className="ml-auto flex gap-x-1">
										<Button variant="ghost" size="sm" onClick={() => setConfirming(null)} disabled={busy}>{zh ? '取消' : 'Cancel'}</Button>
										<Button size="sm" onClick={() => void restore(cp.id)} disabled={busy}>{zh ? '确定回滚' : 'Confirm rollback'}</Button>
													</div>
												</>
											) : (
												<Button
													variant="ghost"
													size="sm"
													className="ml-auto"
													onClick={() => setConfirming(cp.id)}
													disabled={busy || cp.current}
												>
													<RotateCcw />
									{cp.current ? (zh ? '当前位置' : 'Current') : (zh ? '回滚到此' : 'Restore here')}
												</Button>
											)}
										</div>
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</div>
	);
}
