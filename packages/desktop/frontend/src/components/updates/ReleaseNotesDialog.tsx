import { lazy, Suspense, useEffect, useState } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/useI18n';
import { releaseNotesBridge, type ReleaseNotes } from '@/lib/releaseNotes';

const View = lazy(() => import('./ReleaseNotesView'));

export function ReleaseNotesDialog({ notes, onClose, onRetry, installed = false }: {
	notes: ReleaseNotes; onClose: () => void; onRetry?: () => void; installed?: boolean;
}) {
	const { t } = useTranslation();
	return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
		<DialogContent className="sm:max-w-2xl" aria-describedby={undefined} showCloseButton={false}>
			<div className="flex items-center justify-between gap-4"><DialogTitle>{t(installed ? 'releaseNotes.installedTitle' : 'releaseNotes.title', { version: notes.version })}</DialogTitle>
				<button type="button" aria-label={t('markdown.close')} onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m5 5 14 14M19 5 5 19" /></svg></button>
			</div>
			<Suspense fallback={<p role="status" className="text-sm">{t('releaseNotes.loading')}</p>}><View notes={notes} onRetry={onRetry} /></Suspense>
			<div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground">{t('releaseNotes.continue')}</button></div>
		</DialogContent>
	</Dialog>;
}

/** The main process persists acknowledgement per version, including across reinstall/restart. */
export function WhatsNewAfterUpdate() {
	const [notes, setNotes] = useState<ReleaseNotes | null>(null);
	useEffect(() => {
		let active = true;
		void releaseNotesBridge()?.getInstalledReleaseNotes?.().then(value => { if (active) setNotes(value); }).catch(() => {});
		return () => { active = false; };
	}, []);
	if (!notes) return null;
	const close = async () => {
		await releaseNotesBridge()?.acknowledgeReleaseNotes?.(notes.version).catch(() => {});
		setNotes(null);
	};
	return <ReleaseNotesDialog notes={notes} installed onClose={close} />;
}
