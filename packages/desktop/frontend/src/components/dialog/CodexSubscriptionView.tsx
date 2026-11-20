import { Check, ChevronLeft, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { codexApi, type CodexCatalogModel, type CodexFlow, type CodexStatus } from '@/api/codex';
import { DeleteDialog } from '@/components/dialog/DeleteDialog';
import { Button } from '@/components/ui/button';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { useTranslation } from '@/i18n/useI18n';

export function CodexSubscriptionView({ onBack, onChanged, onDone }: { onBack: () => void; onChanged: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [models, setModels] = useState<CodexCatalogModel[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [flow, setFlow] = useState<CodexFlow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const alive = useRef(false), sequence = useRef(0), changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError('');
    try {
      const next = await codexApi.status();
      if (!alive.current || sequence.current !== request) return;
      setStatus(next); setModels([]); setChosen(new Set(next.models.map(model => model.model)));
      if (next.connected) {
        const result = await codexApi.models();
        if (!alive.current || sequence.current !== request) return;
        setModels(result.models);
        setChosen(new Set(result.selected.filter(item => result.models.some(model => model.id === item.model)).map(item => item.model)));
      }
    } catch (reason) {
      if (alive.current && sequence.current === request) {
        const message = reason instanceof Error ? reason.message : 'CODEX_UPSTREAM_ERROR';
        setError(message);
        if (message === 'CODEX_REAUTH_REQUIRED') setStatus(current => current ? { ...current, connected: false, needsReauth: true } : current);
      }
    } finally { if (alive.current && sequence.current === request) setLoading(false); }
  }, []);
  useEffect(() => {
    const requests = sequence;
    alive.current = true;
    void load();
    return () => { alive.current = false; requests.current++; };
  }, [load]);

  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= flow.expiresAt) { setError('CODEX_LOGIN_EXPIRED'); setFlow(null); return; }
      let interval = flow.interval;
      try {
        const result = await codexApi.poll(flow.flowId);
        if (cancelled) return;
        if (result.status === 'connected') {
          setFlow(null); changed.current(); void load(); return;
        }
        interval = result.interval ?? interval;
      } catch (reason) {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : 'CODEX_UPSTREAM_ERROR';
        setError(message);
        if (['CODEX_LOGIN_EXPIRED', 'CODEX_ACCESS_DENIED', 'CODEX_REAUTH_REQUIRED'].includes(message)) { setFlow(null); return; }
        interval = Math.max(5, interval);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), interval * 1000);
    };
    timer = setTimeout(() => void poll(), flow.interval * 1000);
    return () => { cancelled = true; clearTimeout(timer); void codexApi.cancel(flow.flowId).catch(() => {}); };
  }, [flow, load]);

  async function login() {
    const request = ++sequence.current;
    setBusy(true); setError(''); setCopied(false);
    try {
      const next = await codexApi.start();
      if (!alive.current || sequence.current !== request) { await codexApi.cancel(next.flowId); return; }
      setFlow(next);
    } catch (reason) {
      if (alive.current && sequence.current === request) setError(reason instanceof Error ? reason.message : 'CODEX_UPSTREAM_ERROR');
    } finally { if (alive.current && sequence.current === request) setBusy(false); }
  }
  async function copyCode() {
    if (!flow) return;
    try { await navigator.clipboard.writeText(flow.userCode); if (alive.current) setCopied(true); }
    catch { if (alive.current) setError('copy'); }
  }
  async function save() {
    setBusy(true); setError('');
    try {
      await codexApi.saveModels([...chosen].map(model => ({ model, enabled: true })));
      if (alive.current) { changed.current(); onDone(); }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'CODEX_UPSTREAM_ERROR'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function disconnect() {
    try {
      await codexApi.disconnect();
      if (alive.current) { setFlow(null); changed.current(); await load(); }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'CODEX_UPSTREAM_ERROR'); }
  }
  const errorKey = error === 'CODEX_LOGIN_EXPIRED' ? 'loginExpired' : error === 'CODEX_ACCESS_DENIED' ? 'deviceHint' : error === 'CODEX_RATE_LIMIT' ? 'rateLimit' : error === 'CODEX_STORAGE_FAILED' ? 'storageFailed' : error === 'copy' ? 'copyFailed' : error === 'CODEX_REAUTH_REQUIRED' ? 'reauth' : 'error';

  return <section data-model-form data-testid="codex-subscription" className="flex h-full flex-col gap-5">
    <div className="flex items-center gap-2">
      <Button type="button" size="icon-sm" variant="ghost" aria-label={t('modelSection.aria.back')} onClick={onBack}><ChevronLeft /></Button>
      <h3 className="text-lg font-semibold">{t('codex.title')}</h3>
    </div>
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
      <ProviderIcon keyName="openai" size="size-9" />
      <div className="min-w-0 space-y-2 text-sm"><p>{t('codex.subtitle')}</p><p className="text-xs leading-relaxed text-muted-foreground">{t('codex.privacy')}</p></div>
    </div>
    {status?.storage === 'memory' && <p className="rounded-lg border border-border bg-muted p-3 text-xs leading-relaxed">{t('codex.memoryStorage')}</p>}
    {error && <div role="alert" className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive">{t(`codex.${errorKey}`)}</div>}
    {loading ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('common.loading')}</div> : <>
      {status?.connected && <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm"><Check className="size-4" /><span>{t('codex.connected')}</span><span className="text-muted-foreground">{status.email}</span></div>
        <Button type="button" variant="ghost" size="sm" disabled={busy || !!flow} onClick={() => setConfirmDisconnect(true)}>{t('codex.disconnect')}</Button>
      </div>}
      {!status?.connected && !flow && <div className="space-y-3">
        {status?.needsReauth && <p className="text-sm text-muted-foreground">{t('codex.reauth')}</p>}
        <Button type="button" disabled={busy} onClick={() => void login()}>{busy && <Loader2 className="size-4 animate-spin" />}{t('codex.login')}</Button>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('codex.deviceHint')}</p>
      </div>}
      {flow && <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        <div role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" />{t('codex.waiting')}</div>
        <div className="flex flex-wrap items-center gap-3">
          <code data-testid="codex-user-code" className="select-all rounded-lg bg-muted px-4 py-3 font-mono text-xl tracking-widest" dir="ltr">{flow.userCode}</code>
          <Button type="button" size="sm" variant="outline" onClick={() => void copyCode()}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? t('markdown.copied') : t('codex.copyCode')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild><a href="https://auth.openai.com/codex/device" target="_blank" rel="noreferrer noopener">{t('codex.openBrowser')}<ExternalLink className="size-4" /></a></Button>
          <Button type="button" variant="ghost" onClick={() => { setFlow(null); setError(''); }}>{t('common.cancel')}</Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('codex.deviceHint')}</p>
      </div>}
      {status?.connected && !flow && <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{t('modelSection.form.selectedCount', { count: chosen.size })}</span>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void load()}><RefreshCw className="size-3.5" />{t('error.retry')}</Button>
        </div>
        {models.length ? <div className="max-h-80 overflow-y-auto rounded-xl border border-border p-1.5">
          {models.map(model => <label key={model.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted">
            <input type="checkbox" disabled={busy} checked={chosen.has(model.id)} onChange={event => setChosen(current => { const next = new Set(current); if (event.target.checked) next.add(model.id); else next.delete(model.id); return next; })} className="size-4 accent-primary" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{model.name}</span><span className="block truncate font-mono text-xs text-muted-foreground">{model.id}</span></span>
          </label>)}
        </div> : <p className="text-sm text-muted-foreground">{t('modelSection.errors.noModels')}</p>}
        <div className="flex justify-end"><Button type="button" disabled={busy || !models.length} onClick={() => void save()}>{busy && <Loader2 className="size-4 animate-spin" />}{t('common.save')}</Button></div>
      </div>}
    </>}
    <DeleteDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect} title={t('codex.disconnect')} description={t('codex.disconnectHint')} confirmLabel={t('codex.disconnect')} onConfirm={disconnect} />
  </section>;
}
