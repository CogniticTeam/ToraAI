import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const buttonVariants = cva(
	"group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring focus-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive dark:aria-invalid:border-destructive dark:aria-invalid:ring-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 transition-[transform,background-color,color,box-shadow,border-color,filter] duration-150 will-change-transform active:scale-[0.97] active:duration-75 motion-reduce:active:scale-100 motion-reduce:transition-none",
	{
		variants: {
			variant: {
				default:
					'bg-primary text-primary-foreground shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_12%,transparent)] [a]:hover:bg-primary hover:brightness-[1.05]',
				outline:
					'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input dark:hover:bg-input',
				secondary:
					'bg-secondary text-secondary-foreground hover:bg-secondary aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
				ghost: 'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted',
				destructive:
					'bg-destructive-soft text-destructive hover:bg-destructive-soft focus-visible:border-destructive focus-visible:ring-destructive dark:bg-destructive-soft dark:hover:bg-destructive-soft dark:focus-visible:ring-destructive',
				link: 'text-primary underline-offset-4 hover:underline',
			},
			size: {
				default:
					'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				icon: 'size-8',
				'icon-xs':
					"size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
				'icon-sm':
					"size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
				'icon-lg': 'size-9',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'default',
		},
	},
);

function Button({
	className,
	variant = 'default',
	size = 'default',
	asChild = false,
	tooltip = undefined,
	...props
}: React.ComponentProps<'button'> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
		tooltip?: string;
	}) {
	const Comp = asChild ? Slot.Root : 'button';

	if (tooltip === undefined) {
		return (
			<Comp
				data-slot="button"
				data-variant={variant}
				data-size={size}
				className={cn(buttonVariants({ variant, size, className }))}
				{...props}
			/>
		);
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Comp
					data-slot="button"
					data-variant={variant}
					data-size={size}
					className={cn(buttonVariants({ variant, size, className }))}
					{...props}
				/>
			</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export { Button, buttonVariants };
