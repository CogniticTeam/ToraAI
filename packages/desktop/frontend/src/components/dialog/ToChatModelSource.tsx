import { useState } from 'react';

import { useTranslation } from '@/i18n/useI18n';
import { modeCopy, readToChatSource, TOCHAT_SOURCE_EVENT, TOCHAT_SOURCE_KEY, type ToChatSource } from '@/lib/applicationModes';

export function ToChatModelSource() {
	const { i18n } = useTranslation();
	const copy = modeCopy(i18n.language);
	const [source, setSource] = useState(readToChatSource);
	return (
		<div className="my-4 border-b border-border pb-4">
			<label htmlFor="tochat-model-source" className="text-sm font-medium">{copy('source')}</label>
			<p className="mb-2 mt-1 text-xs text-muted-foreground">{copy('sourceHelp')}</p>
			<select id="tochat-model-source" value={source} className="max-w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" onChange={(event) => {
				const next = event.target.value as ToChatSource;
				localStorage.setItem(TOCHAT_SOURCE_KEY, next);
				setSource(next);
				window.dispatchEvent(new Event(TOCHAT_SOURCE_EVENT));
			}}>
				<option value="official">{copy('official')}</option>
				<option value="custom">{copy('custom')}</option>
			</select>
		</div>
	);
}
