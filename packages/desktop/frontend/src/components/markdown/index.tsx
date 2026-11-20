import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import * as React from 'react';
import { Streamdown } from 'streamdown';
import { useReducedMotion } from 'framer-motion';

import { useTranslation } from '@/i18n/useI18n';
import { cn } from '@/lib/utils';

const STREAM_REVEAL = {
	animation: 'blurIn',
	duration: 120,
	stagger: 25,
	maxBacklogMs: 140,
	easing: 'cubic-bezier(0.18, 0.65, 0.24, 1)',
	sep: 'char',
} as const;

const DEFAULT_PLUGINS = { code, math, cjk, mermaid };

function Markdown({
	className,
	plugins = DEFAULT_PLUGINS,
	controls = false,
	animated,
	...props
}: React.ComponentProps<typeof Streamdown>) {
	const { t } = useTranslation();
	const reduceMotion = useReducedMotion();

	return (
		<Streamdown
			data-slot="markdown"
			plugins={plugins}
			controls={controls}
			animated={reduceMotion ? false : animated === true ? STREAM_REVEAL : animated}
			translations={{
				openExternalLink: t('markdown.openExternalLink'),
				externalLinkWarning: t('markdown.externalLinkWarning'),
				copyLink: t('markdown.copyLink'),
				copied: t('markdown.copied'),
				openLink: t('markdown.openLink'),
				close: t('markdown.close'),
			}}
			className={cn('cn-markdown w-full min-w-0 overflow-hidden', className)}
			{...props}
		/>
	);
}

export { Markdown };
