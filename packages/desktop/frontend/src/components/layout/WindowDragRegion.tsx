import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

/** Empty native drag handle: never wrap interactive controls or scroll content. */
export function WindowDragRegion({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div {...props} aria-hidden="true" data-window-drag-region className={cn('app-drag select-none', className)} />;
}
