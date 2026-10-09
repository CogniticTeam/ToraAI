// 设置与权限面板共用的选择框；Portal 避免选项被滚动容器裁切。
import { Check, ChevronDown } from 'lucide-react';
import { Select } from 'radix-ui';
import type { ReactNode } from 'react';

import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

export interface DropdownOption {
	value: string;
	label: string;
	icon?: ReactNode;
	disabled?: boolean;
}

interface Props {
	value: string;
	onChange: (value: string) => void;
	options: DropdownOption[];
	placeholder?: string;
	disabled?: boolean;
	className?: string;
	'aria-label'?: string;
}

export function DropdownSelect({ value, onChange, options, placeholder, disabled, className, 'aria-label': label }: Props) {
	const { t } = useTranslation();
	return (
		<Select.Root value={value} onValueChange={onChange} disabled={disabled}>
			<Select.Trigger aria-label={label} className={cn(
				'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-muted px-3 text-left text-sm outline-none transition-colors',
				'focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-70',
				'data-placeholder:text-muted-foreground', className,
			)}>
				<span className="flex min-w-0 items-center gap-2 [&>span]:truncate">
					<Select.Value placeholder={placeholder ?? t('common.select')} />
				</span>
				<Select.Icon><ChevronDown className="size-4 shrink-0 text-muted-foreground" /></Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content position="popper" align="start" sideOffset={4} collisionPadding={8}
					className="z-50 max-h-[min(15rem,var(--radix-select-content-available-height))] min-w-(--radix-select-trigger-width) max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
					<Select.Viewport className="max-h-[min(15rem,var(--radix-select-content-available-height))] p-1">
						{options.map(option => (
							<Select.Item key={option.value} value={option.value} disabled={option.disabled}
								className="relative flex cursor-default items-center gap-2 rounded-md py-2 pl-3 pr-8 text-sm outline-none data-highlighted:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50 data-[state=checked]:bg-primary-soft data-[state=checked]:font-medium data-[state=checked]:text-primary">
								<Select.ItemText><span className="flex min-w-0 items-center gap-2">{option.icon}<span className="truncate">{option.label}</span></span></Select.ItemText>
								<Select.ItemIndicator className="absolute right-2"><Check className="size-4" /></Select.ItemIndicator>
							</Select.Item>
						))}
					</Select.Viewport>
				</Select.Content>
			</Select.Portal>
		</Select.Root>
	);
}
