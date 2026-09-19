import {
	CircleAlert,
	CheckCircle,
	CornerLeftUp,
	CornerDownLeft,
	File,
	Folder,
	FolderOpen,
	Home,
	Loader2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group';
import type { DirectoryEntry } from '@/api';
import { workspaceApi } from '@/api';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n/useI18n';
import { formatApiErrorForAlert } from '@/lib/api-error';

interface WorkspaceBrowseDialogProps {
	/** Agent owning the session — drives the directory browser root. */
	agentId: string | null;
	/** The open session, whose working directory is being edited. */
	sessionId: string | null;
	/**
	 * The session's current working directory. Absolute, or relative to
	 * the workspace root; `null` is the root itself.
	 */
	value: string | null;
	/** Called with the newly picked directory. */
	onChange: (cwd: string | null) => void | Promise<void>;
	/** Close callback — the picker owns visibility. */
	onClose: () => void;
}

/**
 * 完整目录浏览器（受控，无自带触发器）：路径输入 + 目录逐级浏览。
 * 由 WorkspacePicker 的「选择文件夹」入口打开。
 */
export function WorkspaceBrowseDialog({ agentId, sessionId, value, onChange, onClose }: WorkspaceBrowseDialogProps) {
	const { t } = useTranslation();
	const [path, setPath] = useState('');
	const [listedPath, setListedPath] = useState<string | null>(null);
	const [entries, setEntries] = useState<DirectoryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const reqId = useRef(0);

	const load = useCallback(
		async (target: string) => {
			const id = ++reqId.current;
			setLoading(true);
			setError(null);
			try {
				const listing = await workspaceApi.directories(
					agentId ?? '',
					sessionId ?? '',
					target,
				);
				if (id !== reqId.current) return;
				setEntries(listing.entries);
				setPath(listing.path);
				setListedPath(listing.path);
			} catch (e) {
				if (id !== reqId.current) return;
				setListedPath(null);
				setEntries([]);
				setError(formatApiErrorForAlert(e));
			} finally {
				if (id === reqId.current) setLoading(false);
			}
		},
		[agentId, sessionId],
	);

	useEffect(() => {
		void load(value ?? '');
	}, [value, load]);

	const handleConfirm = async () => {
		setSaving(true);
		setError(null);
		try {
			await onChange(path);
			onClose();
		} catch (e) {
			setError(formatApiErrorForAlert(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t('workdir.title')}</DialogTitle>
					<DialogDescription>{t('workdir.description')}</DialogDescription>
				</DialogHeader>

				<div className="flex min-w-0 flex-col gap-y-2">
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void load(path);
						}}
					>
						<InputGroup>
							<InputGroupInput
								value={path}
								spellCheck={false}
								className="font-mono text-[0.8rem]! tracking-tighter"
								placeholder={t('workdir.pathPlaceholder')}
								onChange={(e) => {
									setPath(e.target.value);
									setError(null);
								}}
							/>
							<InputGroupAddon>
								<Tooltip>
									<TooltipTrigger asChild>
										<InputGroupButton type="button" onClick={() => void load('')}>
											<Home />
										</InputGroupButton>
									</TooltipTrigger>
									<TooltipContent>{t('workdir.root')}</TooltipContent>
								</Tooltip>
							</InputGroupAddon>
							<InputGroupAddon align="inline-end">
								<InputGroupButton type="submit">
									<CornerDownLeft />
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
					</form>
					<div className="h-[50vh] min-w-0 overflow-y-auto border rounded-[1rem] p-1">
						{loading ? (
							<div className="flex h-full items-center justify-center">
								<Spinner className="text-muted-foreground" />
							</div>
						) : error ? (
							<Empty className="h-full border-0 p-4">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<FolderOpen />
									</EmptyMedia>
									<EmptyTitle>{t('workdir.errorTitle')}</EmptyTitle>
									<EmptyDescription className="break-all">{error}</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<>
								<Button
									variant="ghost"
									size="sm"
									className="w-full justify-start gap-2 font-normal"
									onClick={() => void load(`${listedPath ?? ''}/..`)}
								>
									<CornerLeftUp className="size-3.5 shrink-0" />
									{t('workdir.parent')}
								</Button>
								{entries.length === 0 ? (
									<p className="px-2 py-3 text-center text-xs text-muted-foreground">
										{t('workdir.empty')}
									</p>
								) : (
									entries.map((entry) => (
										<Button
											key={entry.name}
											variant="ghost"
											size="sm"
											disabled={!entry.is_dir}
											className="w-full min-w-0 justify-start gap-2 font-normal"
											onClick={() => void load(`${listedPath ?? ''}/${entry.name}`)}
										>
											{entry.is_dir ? (
												<Folder className="size-3.5 shrink-0" />
											) : (
												<File className="size-3.5 shrink-0" />
											)}
											<span className="min-w-0 truncate">{entry.name}</span>
										</Button>
									))
								)}
							</>
						)}
					</div>
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={saving}>
						<CircleAlert className="size-3.5" />
						{t('common.cancel')}
					</Button>
					<Button
						onClick={() => void handleConfirm()}
						disabled={saving || listedPath !== path}
						title={listedPath === path ? undefined : t('workdir.pressEnter')}
					>
						{saving ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<CheckCircle className="size-3.5" />
						)}
						{t('common.confirm')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
