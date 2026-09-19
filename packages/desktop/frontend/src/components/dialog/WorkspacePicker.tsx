import { ChevronDown, Clock, Folder, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n/useI18n';

const apiBase = () =>
	(localStorage.getItem('server_url') || 'http://127.0.0.1:3210').replace(/\/+$/, '');
const apiUrl = (p: string) => `${apiBase()}${p}`;

/** The last segment of a path, which is what a folder is called. */
function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	const cut = trimmed.lastIndexOf('/');
	return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

interface WorkspacePickerProps {
	/** Current working directory, relative to the workspace root. */
	value: string | null;
	/** Persists a new working directory. */
	onChange: (cwd: string | null) => void | Promise<void>;
	disabled?: boolean;
	className?: string;
}

/**
 * 工作目录选择器（参考 WorkBuddy 设计）：
 * 触发按钮显示当前目录名（未选择时显示「选择文件夹（可选）」），
 * 点击弹出面板——上方为「最近」使用过的目录列表（名称 + 截断路径），
 * 点击即切换；底部「选择文件夹」打开完整目录浏览器。
 */
export function WorkspacePicker({ value, onChange, disabled, className }: WorkspacePickerProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [, setBrowseOpen] = useState(false);
	const [recents, setRecents] = useState<string[] | null>(null);

	const loadRecents = useCallback(async () => {
		try {
			const res = await fetch(apiUrl('/admin/workspace-recents'));
			const body = await res.json();
			setRecents(Array.isArray(body.recents) ? body.recents : []);
		} catch {
			setRecents([]);
		}
	}, []);

	// 每次打开弹层都刷新「最近」列表
	useEffect(() => {
		if (open) void loadRecents();
	}, [open, loadRecents]);

	const handlePick = async (dir: string) => {
		setOpen(false);
		await onChange(dir);
	};

	const label = value ? basename(value) : t('workdir.pickerPlaceholder');

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled}
						className={className}
						title={value ?? undefined}
					>
						<FolderOpen />
						<span className="truncate max-w-40">{label}</span>
						<ChevronDown className="text-muted-foreground" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-80 p-0">
					<div className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
						{t('workdir.recent')}
					</div>
					<div className="max-h-64 overflow-y-auto px-1.5 pb-1">
						{recents === null ? (
							<div className="flex h-16 items-center justify-center">
								<Spinner className="text-muted-foreground" />
							</div>
						) : recents.length === 0 ? (
							<div className="flex h-16 flex-col items-center justify-center gap-1 text-muted-foreground">
								<Clock className="size-4" />
								<span className="text-xs">{t('workdir.recentEmpty')}</span>
							</div>
						) : (
							recents.map((dir) => (
								<button
									key={dir}
									type="button"
									className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted"
									onClick={() => void handlePick(dir)}
								>
									<Folder className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm">{basename(dir)}</span>
										<span className="block truncate text-xs text-muted-foreground">
											{dir}
										</span>
									</span>
								</button>
							))
						)}
					</div>
					<div className="border-t p-1.5">
						<button
							type="button"
							className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted"
							onClick={async () => {
								// Electron shell: system folder picker (NSOpenPanel / IFileOpenDialog)
								const bridge = (window as unknown as { cocodeWindow?: { openFolderDialog: () => Promise<string | null> } }).cocodeWindow;
								if (bridge?.openFolderDialog) {
									const dir = await bridge.openFolderDialog();
									if (dir) {
										setOpen(false);
										await onChange(dir);
									}
									return;
								}
								// Browser env (no shell): fallback to custom directory browser
								setOpen(false);
								setBrowseOpen(true);
							}}
						>
							<FolderOpen className="size-4 shrink-0 text-muted-foreground" />
							<span className="text-sm">{t('workdir.browse')}</span>
						</button>
					</div>
				</PopoverContent>
			</Popover>

		</>
	);
}
