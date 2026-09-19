// 自定义下拉选择框（替代浏览器原生 <select>，样式与设置窗口统一）
// 分层：触发按钮 z-1，浮层面板 z-10（遵循项目 z-index 规范）
import { useEffect, useRef, useState } from 'react';

import { Check, ChevronDown } from 'lucide-react';

import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

export interface DropdownOption {
	value: string;
	label: string;
	disabled?: boolean;
}

interface Props {
	value: string;
	onChange: (value: string) => void;
	options: DropdownOption[];
	placeholder?: string;
	disabled?: boolean;
	className?: string;
}

export function DropdownSelect({ value, onChange, options, placeholder, disabled, className }: Props) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const current = options.find((o) => o.value === value);

	// 点击组件外部关闭
	useEffect(() => {
		if (!open) return;
		const onDocClick = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onEsc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		document.addEventListener('mousedown', onDocClick);
		document.addEventListener('keydown', onEsc);
		return () => {
			document.removeEventListener('mousedown', onDocClick);
			document.removeEventListener('keydown', onEsc);
		};
	}, [open]);

	return (
		<div ref={rootRef} className={cn('relative', className)}>
			{/* 触发按钮 */}
			<button
				type="button"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				className={cn(
					'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-muted px-3 text-left text-sm outline-none transition-colors',
					'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
					'data-disabled:cursor-not-allowed data-disabled:opacity-70',
				)}
				data-disabled={disabled ? '' : undefined}
				onClick={() => setOpen((v) => !v)}
			>
				<span className={cn('truncate', !current && 'text-muted-foreground')}>
					{current?.label ?? placeholder ?? t('common.select')}
				</span>
				<ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
			</button>

			{/* 选项浮层 */}
			{open && (
				<ul
					role="listbox"
					className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
				>
					{options.map((o) => {
						const selected = o.value === value;
						return (
							<li key={o.value}>
								<button
									type="button"
									role="option"
									aria-selected={selected}
									disabled={o.disabled}
									className={cn(
										'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
										'hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
										selected && 'bg-primary-soft font-medium text-primary',
									)}
									onClick={() => {
										onChange(o.value);
										setOpen(false);
									}}
								>
									<span className="truncate">{o.label}</span>
									{selected && <Check className="size-4 shrink-0" />}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
