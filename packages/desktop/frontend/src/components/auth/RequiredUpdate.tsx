import { useEffect, useState } from 'react';

import { useTranslation } from '@/i18n/useI18n';

type State = { version: string; platform: string; status: 'available' | 'downloading' | 'ready' | 'error'; percent?: number };
type Bridge = { getRequiredUpdate: () => State | null; onRequiredUpdate: (cb: (value: State | null) => void) => () => void; updateAction: (action: string) => Promise<unknown> };
const bridge = () => (window as unknown as { cocodeWindow?: Bridge }).cocodeWindow;

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
  const action = (name: string) => void bridge()?.updateAction(name);
  return <div className="fixed inset-0 z-[300] grid place-items-center bg-background/95 p-8" role="alertdialog" aria-modal="true" aria-labelledby="required-update-title">
    <div className="w-full max-w-md space-y-5 rounded-2xl border border-border bg-card p-7 shadow-xl">
      <h1 id="required-update-title" className="text-xl font-medium">{t('requiredUpdate.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('requiredUpdate.description', { version: state.version })}</p>
      {state.platform === 'darwin' && state.status === 'error' && <p className="text-sm leading-6 text-muted-foreground">{t('requiredUpdate.macHint')}</p>}
      {state.status === 'downloading' && <div role="status" className="space-y-3 text-sm">
        <p>{t('requiredUpdate.downloading', { percent: state.percent || 0 })}</p>
        <progress className="w-full accent-current" value={state.percent || 0} max="100" />
      </div>}
      {state.status === 'error' && <p role="alert" className="text-sm text-destructive">{t('requiredUpdate.error')}</p>}
      <div className="flex flex-wrap gap-2">
        {state.status === 'ready' && <button autoFocus onClick={() => action('install')} className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground">{t('requiredUpdate.install')}</button>}
        {state.status === 'error' && <button onClick={() => action('retry')} className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground">{t('requiredUpdate.retry')}</button>}
        {state.status === 'error' && <button onClick={() => action('download')} className="rounded-xl border border-border px-4 py-2 text-sm">{t('requiredUpdate.download')}</button>}
        <button onClick={() => action('quit')} className="rounded-xl border border-border px-4 py-2 text-sm">{t('requiredUpdate.quit')}</button>
      </div>
    </div>
  </div>;
}
