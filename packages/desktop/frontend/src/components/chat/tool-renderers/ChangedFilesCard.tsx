import { ArrowUpRight, ChevronDown, FileText } from 'lucide-react';
import { useState } from 'react';

import { DiffStats } from './_shared';
import type { ChangedFileEntry } from './_shared';
import { DiffPreview } from './DiffPreview';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n/useI18n';
import { requestPanel } from '@/lib/openPanel';
import { cn } from '@/lib/utils';

/**
 * 回合结束时的「文件更改」汇总卡片：头部为标题 + 总增删行数 + 打开右侧
 * diff 面板的入口；每个文件行可点击行内展开该文件的 diff 预览。
 */
export function ChangedFilesCard({ files }: { files: ChangedFileEntry[] }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(true);
	const [expandedPath, setExpandedPath] = useState<string | null>(null);

	const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
	const totalRemoved = files.reduce((sum, f) => sum + f.removed, 0);

	return (
		<div className="mt-2 w-full overflow-hidden rounded-rect border border-border bg-muted/40 text-sm">
			<div className="flex items-center gap-1.5 py-1.5 pr-1.5 pl-3">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
				>
					<ChevronDown
						className={cn(
							'size-3.5 shrink-0 text-muted-foreground transition-transform',
							!open && '-rotate-90',
						)}
					/>
					<FileText className="size-4 shrink-0 text-muted-foreground" />
					<span className="font-medium whitespace-nowrap">
						{t('messageBubble.changedFiles.title', { count: files.length })}
					</span>
					<DiffStats insertions={totalAdded} deletions={totalRemoved} />
				</button>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							className="shrink-0 text-muted-foreground"
							onClick={() => requestPanel('diff')}
						>
							<ArrowUpRight className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent side="top">
						{t('messageBubble.changedFiles.openPanel')}
					</TooltipContent>
				</Tooltip>
			</div>
			{open && (
				<div className="border-t border-border">
					{files.map((file) => (
						<div key={file.path} className="border-b border-border last:border-b-0">
							<button
								type="button"
								onClick={() =>
									setExpandedPath((p) => (p === file.path ? null : file.path))
								}
								className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted"
							>
								<FileText className="size-3.5 shrink-0 text-amber-500" />
								<span className="shrink-0 font-medium">{file.name}</span>
								{file.dir && (
									<span className="min-w-0 truncate text-xs text-muted-foreground">
										{file.dir}
									</span>
								)}
								<DiffStats
									insertions={file.added}
									deletions={file.removed}
									className="ml-auto shrink-0"
								/>
							</button>
							{expandedPath === file.path && (
								<div className="border-t border-border/60 bg-background/50 px-2 py-2">
									<DiffPreview unifiedDiff={file.diff} />
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
