import {
	BellOff,
	ChevronDown,
	Compass,
	Hand,
	ShieldCheck,
	ShieldAlert,
	TriangleAlert,
	UserRoundKey,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { PermissionMode } from '@/api/types';
import { FIRST_RUN_CLOSE_PERMISSION_EVENT, FIRST_RUN_PERMISSION_CLOSED_EVENT, FIRST_RUN_PERMISSION_OPENED_EVENT } from '@/components/onboarding/constants';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslation } from '@/i18n/useI18n.ts';
import { requestPanel } from '@/lib/openPanel.ts';
import { cn } from '@/lib/utils.ts';

const PERMISSION_MODES: {
	value: PermissionMode;
	labelKey: string;
	descKey: string;
	icon: typeof Hand;
}[] = [
	{
		value: 'default',
		labelKey: 'permission-mode.default',
		descKey: 'permission-mode.default-desc',
		icon: Hand,
	},
	{
		value: 'accept_edits',
		labelKey: 'permission-mode.accept_edits',
		descKey: 'permission-mode.accept_edits-desc',
		icon: ShieldCheck,
	},
	{
		value: 'explore',
		labelKey: 'permission-mode.explore',
		descKey: 'permission-mode.explore-desc',
		icon: Compass,
	},
	{
		value: 'bypass',
		labelKey: 'permission-mode.bypass',
		descKey: 'permission-mode.bypass-desc',
		icon: TriangleAlert,
	},
	{
		value: 'dont_ask',
		labelKey: 'permission-mode.dont_ask',
		descKey: 'permission-mode.dont_ask-desc',
		icon: BellOff,
	},
];

interface Props extends Omit<React.ComponentPropsWithoutRef<typeof Button>, 'onChange' | 'value'> {
	className?: string;
	composer?: boolean;
	value?: PermissionMode;
	disabled?: boolean;
	/** 菜单头部显示「了解更多」，点击打开权限规则面板（聊天页用；表单里不传） */
	learnMore?: boolean;
	onChange?: (value: PermissionMode) => void;
}

export function PermissionModeSelect({
	className,
	composer = false,
	value,
	disabled,
	learnMore,
	onChange,
	...props
}: Props) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const close = () => setOpen(false);
		window.addEventListener(FIRST_RUN_CLOSE_PERMISSION_EVENT, close);
		return () => window.removeEventListener(FIRST_RUN_CLOSE_PERMISSION_EVENT, close);
	}, []);

	const displayLabel = value
		? t(PERMISSION_MODES.find((m) => m.value === value)?.labelKey ?? value)
		: t('permission-mode.placeholder');
	const ModeIcon = composer
		? value === 'bypass' ? ShieldAlert : (PERMISSION_MODES.find((mode) => mode.value === value)?.icon ?? UserRoundKey)
		: UserRoundKey;

	return (
		<DropdownMenu modal={false} open={open} onOpenChange={(next) => {
			setOpen(next);
			window.dispatchEvent(new Event(next ? FIRST_RUN_PERMISSION_OPENED_EVENT : FIRST_RUN_PERMISSION_CLOSED_EVENT));
		}}>
			<DropdownMenuTrigger asChild>
				<Button
					variant={composer ? 'ghost' : 'outline'}
					size="sm"
					className={cn(
						'justify-between gap-1 font-normal',
						composer && 'h-9 border-0 bg-transparent px-2 text-sm hover:bg-muted/60',
						composer && value === 'bypass' && 'text-orange-600 hover:text-orange-600 dark:text-orange-400 dark:hover:text-orange-400',
						className,
					)}
					disabled={disabled}
					tooltip={t('permission-mode.trigger-tooltip')}
					{...props}
				>
					<div className="flex flex-row items-center gap-x-2">
						<ModeIcon className="size-4" />
						<span className="truncate">{displayLabel}</span>
					</div>
					{!composer && <ChevronDown className="size-3.5 text-muted-foreground" />}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-84! p-1.5">
				<div className="flex items-center justify-between px-1.5 py-1">
					<span className="text-sm font-medium">{t('permission-mode.panel-title')}</span>
					{learnMore && (
						<button
							type="button"
							className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
							onClick={() => {
								setOpen(false);
								requestPanel('permission');
							}}
						>
							{t('permission-mode.learn-more')}
						</button>
					)}
				</div>
				<DropdownMenuRadioGroup
					value={value ?? ''}
					onValueChange={(mode) => onChange?.(mode as PermissionMode)}
				>
					{PERMISSION_MODES.map((mode) => {
						const Icon = mode.icon;
						const selected = value === mode.value;
						return (
							<DropdownMenuRadioItem
								key={mode.value}
								value={mode.value}
								className={cn(
									'items-start! gap-2.5! rounded-lg! py-2! pl-2.5!',
									selected &&
										'bg-amber-100! text-amber-900! focus:bg-amber-100! focus:text-amber-900! focus:**:text-amber-900! dark:bg-amber-500/15! dark:text-amber-300! dark:focus:bg-amber-500/15! dark:focus:text-amber-300! dark:focus:**:text-amber-300!',
								)}
							>
								<Icon
									className={cn(
										'mt-0.5 size-4 shrink-0',
										selected ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
									)}
								/>
								<span className="flex min-w-0 flex-col gap-0.5">
									<span className="text-sm leading-4 font-medium">{t(mode.labelKey)}</span>
									<span
										className={cn(
											'text-xs leading-4',
											selected ? 'text-amber-800/80 dark:text-amber-300/70' : 'text-muted-foreground',
										)}
									>
										{t(mode.descKey)}
									</span>
								</span>
							</DropdownMenuRadioItem>
						);
					})}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
