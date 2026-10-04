import { Markdown } from '@/components/markdown';
import { useTranslation } from '@/i18n/useI18n';
import { releaseNotesBridge, type ReleaseNotes } from '@/lib/releaseNotes';

export default function ReleaseNotesView({ notes, onRetry }: { notes: ReleaseNotes; onRetry?: () => void }) {
	const { t } = useTranslation();
	return <section className="space-y-3" data-release-notes-version={notes.version} aria-label={t('releaseNotes.forVersion', { version: notes.version })}>
		<h2 className="text-sm font-medium">{t('releaseNotes.forVersion', { version: notes.version })}</h2>
		<div className="app-no-drag max-h-[42dvh] overflow-y-auto overscroll-contain rounded-xl bg-muted/40 p-4 text-sm leading-6 [overflow-wrap:anywhere]">
			{notes.status === 'loading' && <p role="status">{t('releaseNotes.loading')}</p>}
			{notes.status === 'error' && <p role="status">{t('releaseNotes.error')}</p>}
			{notes.status === 'empty' && <p>{t('releaseNotes.empty')}</p>}
			{notes.status === 'ready' && <Markdown mode="static" dir="auto" plugins={{}} skipHtml components={{ img: ({ alt }) => <span>{alt}</span> }}>{notes.notes}</Markdown>}
		</div>
		<div className="flex flex-wrap gap-3 text-xs">
			{notes.status === 'error' && onRetry && <button type="button" className="underline underline-offset-4" onClick={onRetry}>{t('releaseNotes.retry')}</button>}
			<button type="button" className="underline underline-offset-4" onClick={() => void releaseNotesBridge()?.openReleaseNotes?.(notes.version)}>{t('releaseNotes.open')}</button>
		</div>
	</section>;
}
