import { ChevronDown, ChevronUp, CornerDownLeft, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { UserQuestionEntry } from '@/hooks/useMessages';
import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

/** Sentinel index for the virtual "Other" row (free-text input). */
const OTHER = -2;

/**
 * AskUserQuestion 面板：AI 在运行中途抛出的选择题，浮在输入框上方。
 *
 * 分页浏览（1 of N），每页一题；最后一「页」是可选的补充信息文本域。
 * 键盘优先：↑↓ 移动高亮行、Enter 确认并前进、⌘/Ctrl+Enter 直接提交、
 * ESC 取消。单选点击即选并翻页；多选点击 toggle、Enter 翻页。每题末尾
 * 都有「其他」行，选中后可自由输入（≤500 字）。
 */
export function QuestionPanel({
	entry,
	onSubmit,
	onCancel,
}: {
	entry: UserQuestionEntry;
	onSubmit: (
		answers: Array<{ selected: string[]; other?: string }>,
		note: string,
	) => Promise<void> | void;
	onCancel: () => Promise<void> | void;
}) {
	const { t } = useTranslation();
	const questions = entry.questions ?? [];
	const supplementPage = questions.length; // index of the note page
	const totalPages = questions.length + 1; // +1 for the supplement page

	const [page, setPage] = useState(0);
	const [active, setActive] = useState(0); // keyboard cursor within a page
	const [selections, setSelections] = useState<Array<string[]>>(() =>
		questions.map(() => []),
	);
	const [others, setOthers] = useState<Array<string>>(() => questions.map(() => ''));
	const [note, setNote] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const otherRefs = useRef<Array<HTMLInputElement | null>>([]);
	const noteRef = useRef<HTMLTextAreaElement | null>(null);

	const isSupplement = page === supplementPage;
	const q = questions[page];
	const optionCount = (q?.options?.length ?? 0) + 1; // +1 for "Other"

	// 翻页时把键盘光标复位到「已选第一项」或 0
	useEffect(() => {
		const sel = selections[page];
		if (sel && sel.length) {
			const idx = q?.options?.findIndex((o) => o.label === sel[0]) ?? -1;
			setActive(idx >= 0 ? idx : OTHER);
		} else {
			setActive(0);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [page]);

	const commit = useCallback(
		async (cancelled: boolean) => {
			if (submitting) return;
			setSubmitting(true);
			const answers = questions.map((_, i) => {
				const selected = selections[i] ?? [];
				const other = (others[i] ?? '').trim();
				return { selected, other: other || undefined };
			});
			try {
				if (cancelled) await onCancel();
				else await onSubmit(answers, note.trim());
			} finally {
				setSubmitting(false);
			}
		},
		[questions, selections, others, note, submitting, onSubmit, onCancel],
	);

	const toggleOption = useCallback(
		(label: string) => {
			setSelections((prev) => {
				const cur = prev[page] ?? [];
				if (q?.multiSelect) {
					const next = cur.includes(label)
						? cur.filter((x) => x !== label)
						: [...cur, label];
					return prev.map((v, i) => (i === page ? next : v));
				}
				// 单选：替换并自动前进
				const next = prev.map((v, i) => (i === page ? [label] : v));
				if (page < totalPages - 1) setPage(page + 1);
				return next;
			});
		},
		[page, q?.multiSelect, totalPages],
	);

	const focusOther = useCallback((idx: number) => {
		requestAnimationFrame(() => otherRefs.current[idx]?.focus());
	}, []);

	// 全局键盘：仅当焦点不在输入框时接管方向键 / Enter
	useEffect(() => {
		const onKey = async (e: KeyboardEvent) => {
			const el = e.target as HTMLElement | null;
			const typing =
				el &&
				(el.tagName === 'INPUT' ||
					el.tagName === 'TEXTAREA' ||
					el.isContentEditable);

			if (e.key === 'Escape') {
				e.preventDefault();
				await commit(true);
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault();
				await commit(false);
				return;
			}
			// 在补充信息文本域里：不拦截方向键（光标移动），Enter 换行
			if (isSupplement && typing) return;
			// 在「其他」输入框里：Enter 前进，方向键交回浏览器
			if (typing) {
				if (e.key === 'Enter') {
					e.preventDefault();
					if (page < totalPages - 1) setPage(page + 1);
					else await commit(false);
				}
				return;
			}
			if (isSupplement) {
				// 补充信息页无选项列表，Enter 提交
				if (e.key === 'Enter') {
					e.preventDefault();
					await commit(false);
				}
				return;
			}
			switch (e.key) {
				case 'ArrowUp':
					e.preventDefault();
					setActive((a) => (a - 1 + optionCount) % optionCount);
					break;
				case 'ArrowDown':
					e.preventDefault();
					setActive((a) => (a + 1) % optionCount);
					break;
				case 'Enter': {
					e.preventDefault();
					if (active === OTHER) {
						focusOther(page);
					} else {
						const label = q?.options?.[active]?.label;
						if (label) {
							if (q?.multiSelect) toggleOption(label);
							else toggleOption(label); // 单选内部会翻页
						}
					}
					break;
				}
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [commit, isSupplement, page, totalPages, active, optionCount, q, toggleOption, focusOther]);

	const goPrev = () => setPage((p) => Math.max(0, p - 1));
	const goNext = () => setPage((p) => Math.min(totalPages - 1, p + 1));

	return (
		<div className="bg-muted ring ring-border rounded-[28px] w-full px-6 py-5 text-sm overflow-hidden space-y-4">
			{/* 头部：标题 + 分页 + 关闭 */}
			<div className="flex items-center justify-between gap-3">
				<strong className="text-secondary-foreground truncate">
					{isSupplement
						? t('questionPanel.supplementTitle')
						: q?.question ?? ''}
					{isSupplement && (
						<span className="text-muted-foreground font-normal ml-1">
							（{t('questionPanel.optional')}）
						</span>
					)}
				</strong>
				<div className="flex items-center gap-1 shrink-0">
					<button
						type="button"
						onClick={goPrev}
						disabled={page === 0}
						className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
						aria-label={t('questionPanel.prev')}
					>
						<ChevronUp className="size-4" />
					</button>
					<span className="text-muted-foreground tabular-nums text-xs min-w-[52px] text-center">
						{page + 1} {t('questionPanel.of')} {totalPages}
					</span>
					<button
						type="button"
						onClick={goNext}
						disabled={page === totalPages - 1}
						className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
						aria-label={t('questionPanel.next')}
					>
						<ChevronDown className="size-4" />
					</button>
					<button
						type="button"
						onClick={() => void commit(true)}
						className="p-1 rounded text-muted-foreground hover:text-foreground ml-1"
						aria-label={t('questionPanel.cancel')}
					>
						<X className="size-4" />
					</button>
				</div>
			</div>

			{/* 主体：选项列表 或 补充信息文本域 */}
			{isSupplement ? (
				<div className="relative">
					<textarea
						ref={noteRef}
						value={note}
						onChange={(e) => setNote(e.target.value.slice(0, 1000))}
						placeholder={t('questionPanel.supplementPlaceholder')}
						maxLength={1000}
						rows={6}
						className="w-full resize-none bg-background ring ring-border rounded-xl px-4 py-3 pr-16 pb-8 text-sm outline-none focus:ring-foreground/30"
					/>
					<span className="absolute bottom-3 right-4 text-xs text-muted-foreground tabular-nums">
						{note.length}/1000
					</span>
				</div>
			) : (
				<div className="flex flex-col gap-y-1">
					{q?.options?.map((opt, i) => {
						const selected = selections[page]?.includes(opt.label);
						const isActive = active === i;
						return (
							<button
								key={opt.label}
								type="button"
								onMouseEnter={() => setActive(i)}
								onClick={() => toggleOption(opt.label)}
								className={cn(
									'flex items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors',
									isActive ? 'bg-background' : 'hover:bg-background/60',
								)}
							>
								<span className="min-w-0 flex-1">
									<span
										className={cn(
											'font-medium',
											selected ? 'text-primary' : 'text-foreground',
										)}
									>
										{opt.label}
									</span>
									{opt.description && (
										<span className="text-muted-foreground ml-2">
											{opt.description}
										</span>
									)}
								</span>
								{isActive && (
									<span className="text-muted-foreground shrink-0 flex flex-col leading-none">
										<ChevronUp className="size-3" />
										<ChevronDown className="size-3 -mt-1" />
									</span>
								)}
							</button>
						);
					})}
					{/* 「其他」自由输入行 */}
					<div
						onMouseEnter={() => setActive(OTHER)}
						className={cn(
							'flex items-center gap-2 rounded-lg px-3 py-2',
							active === OTHER ? 'bg-background' : '',
						)}
					>
						<span className="font-medium shrink-0">{t('questionPanel.other')}</span>
						<input
							ref={(el) => {
								otherRefs.current[page] = el;
							}}
							value={others[page] ?? ''}
							onChange={(e) =>
								setOthers((prev) =>
									prev.map((v, i) =>
										i === page ? e.target.value.slice(0, 500) : v,
									),
								)
							}
							onFocus={() => setActive(OTHER)}
							placeholder={t('questionPanel.otherPlaceholder')}
							maxLength={500}
							className="flex-1 min-w-0 bg-transparent border-b border-border focus:border-foreground/40 outline-none py-0.5 text-sm"
						/>
						<span className="text-xs text-muted-foreground tabular-nums shrink-0">
							{(others[page] ?? '').length}/500
						</span>
					</div>
				</div>
			)}

			{/* 底部按钮 */}
			<div className="flex items-center justify-end gap-2 pt-1">
				<button
					type="button"
					onClick={() => void commit(true)}
					className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-background"
				>
					{t('questionPanel.cancel')}
					<span className="text-xs text-muted-foreground/60">ESC</span>
				</button>
				{page > 0 && (
					<button
						type="button"
						onClick={goPrev}
						className="rounded-lg px-4 py-1.5 text-foreground hover:bg-background"
					>
						{t('questionPanel.prev')}
					</button>
				)}
				{page < totalPages - 1 ? (
					<button
						type="button"
						onClick={goNext}
						className="flex items-center gap-2 rounded-lg bg-foreground text-background px-5 py-1.5 font-medium hover:bg-foreground/85"
					>
						{t('questionPanel.next')}
						<CornerDownLeft className="size-3.5" />
					</button>
				) : (
					<button
						type="button"
						disabled={submitting}
						onClick={() => void commit(false)}
						className="flex items-center gap-2 rounded-lg bg-foreground text-background px-5 py-1.5 font-medium hover:bg-foreground/85 disabled:opacity-60"
					>
						{t('questionPanel.submit')}
						<span className="text-xs opacity-70">⌘ </span>
					</button>
				)}
			</div>
		</div>
	);
}
