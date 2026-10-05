import { lazy, Suspense, useEffect, useState } from 'react';

import { Progress } from '@/components/ui/progress';
import { useTranslation } from '@/i18n/useI18n';
import { releaseNotesBridge, type ReleaseNotes } from '@/lib/releaseNotes';

const NotesView = lazy(() => import('@/components/updates/ReleaseNotesView'));
type State = { version: string; platform: string; status: 'available' | 'downloading' | 'ready' | 'error'; percent?: number; releaseNotes?: ReleaseNotes | null };
type Bridge = { getRequiredUpdate: () => State | null; onRequiredUpdate: (cb: (value: State | null) => void) => () => void; updateAction: (action: string) => Promise<unknown> };
const bridge = () => (window as unknown as { toraWindow?: Bridge }).toraWindow;

export function RequiredUpdate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<State | null>(() => bridge()?.getRequiredUpdate?.() ?? null);
  useEffect(() => {
    const unsubscribe = bridge()?.onRequiredUpdate?.(setState);
    // 订阅后再读一次，覆盖首帧与订阅之间返回的更新结果。
    setState(bridge()?.getRequiredUpdate?.() ?? null);
    return unsubscribe;
  }, []);
  if (!state) return <>{children}</>;
  const percent = Math.min(100, Math.max(0, Number.isFinite(state.percent) ? state.percent! : 0));
  const action = (name: string) => void bridge()?.updateAction(name);
  const retryNotes = async () => {
    const version = state.version;
    try {
      const notes = await releaseNotesBridge()?.getReleaseNotes?.(version);
      if (notes) setState(current => current?.version === version ? { ...current, releaseNotes: notes } : current);
    } catch { /* Keep download progress and allow another notes retry. */ }
  };
  return <div className="fixed inset-0 z-[300] grid place-items-center overflow-y-auto bg-background/95 p-8" role="alertdialog" aria-modal="true" aria-labelledby="required-update-title">
    <div className="app-no-drag w-full max-w-2xl space-y-5 rounded-2xl border border-border bg-card p-7 shadow-xl">
      <h1 id="required-update-title" className="text-xl font-medium">{t('requiredUpdate.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('requiredUpdate.description', { version: state.version })}</p>
      {state.platform === 'darwin' && state.status === 'error' && <p className="text-sm leading-6 text-muted-foreground">{t('requiredUpdate.macHint')}</p>}
      {state.status === 'downloading' && <div className="space-y-2.5 py-2">
        <div className="flex items-baseline justify-between gap-4 text-xs">
          <span className="text-muted-foreground">{t('requiredUpdate.downloadLabel')}</span>
          <span className="shrink-0 font-medium tabular-nums text-foreground">{Math.round(percent)}%</span>
        </div>
        <Progress
          value={percent}
          aria-label={t('requiredUpdate.downloadLabel')}
          className="h-1.5 rounded-full bg-foreground/8 [&_[data-slot=progress-indicator]]:rounded-full [&_[data-slot=progress-indicator]]:bg-foreground/90 [&_[data-slot=progress-indicator]]:transition-transform [&_[data-slot=progress-indicator]]:duration-300 [&_[data-slot=progress-indicator]]:ease-out [&_[data-slot=progress-indicator]]:motion-reduce:transition-none"
        />
      </div>}
      {state.status === 'error' && <p role="alert" className="text-sm text-destructive">{t('requiredUpdate.error')}</p>}
      {state.releaseNotes?.version === state.version && <Suspense fallback={<p role="status" className="text-sm">{t('releaseNotes.loading')}</p>}><NotesView notes={state.releaseNotes} onRetry={() => void retryNotes()} /></Suspense>}
      <div className="flex flex-wrap gap-2">
        {state.status === 'ready' && <button autoFocus onClick={() => action('install')} className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground">{t('requiredUpdate.install')}</button>}
        {state.status === 'error' && <button onClick={() => action('retry')} className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground">{t('requiredUpdate.retry')}</button>}
        {state.status === 'error' && <button onClick={() => action('download')} className="rounded-xl border border-border px-4 py-2 text-sm">{t('requiredUpdate.download')}</button>}
        <button onClick={() => action('quit')} className="rounded-xl border border-border px-4 py-2 text-sm">{t('requiredUpdate.quit')}</button>
      </div>
    </div>
  </div>;
}
