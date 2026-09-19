import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import {
	CircleCheckIcon,
	InfoIcon,
	TriangleAlertIcon,
	OctagonXIcon,
	Loader2Icon,
} from 'lucide-react';

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = 'system' } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps['theme']}
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				error: <OctagonXIcon className="size-4" />,
				loading: <Loader2Icon className="size-4 animate-spin" />,
			}}
			style={
				{
					'--normal-bg': 'color-mix(in oklab, var(--popover) 82%, transparent)',
					'--normal-text': 'var(--popover-foreground)',
					'--normal-border': 'var(--border)',
					'--border-radius': 'var(--radius)',
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast:
						'cn-toast bg-popover border border-border shadow-lg transition-all duration-200',
					title: 'text-sm font-medium',
					description: 'text-xs text-muted-foreground',
				},
			}}
			duration={4500}
			{...props}
		/>
	);
};

export { Toaster };
