import { Heart, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/useI18n';
import { cloudFetch } from '@/utils/modelSync';

const SPONSOR_URL = 'https://ifdian.net/a/zhenxun111';
type Sponsor = { name: string };
type SponsorResponse = { page: number; month: string; hasMore: boolean; supporters: Sponsor[] };

export function SponsorsDialog({ mode, onClose }: { mode: 'list' | 'donate'; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(mode === 'donate');
  const [supporters, setSupporters] = useState<Sponsor[]>([]);
  const [page, setPage] = useState(0);
  const [retryPage, setRetryPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [month, setMonth] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);

  async function load(nextPage: number) {
    if (loading) return;
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    setError(false);
    try {
      const response = await cloudFetch(`/supporters?page=${nextPage}`, { signal: current.signal });
      if (!response.ok) throw new Error('sponsors unavailable');
      const data = await response.json() as SponsorResponse;
      if (!Array.isArray(data.supporters) || typeof data.hasMore !== 'boolean' || !/^\d{4}-\d{2}$/.test(data.month)) throw new Error('invalid sponsors');
      if (current.signal.aborted) return;
      setSupporters(previous => nextPage === 1 ? data.supporters : [...previous, ...data.supporters]);
      setPage(nextPage);
      setHasMore(data.hasMore);
      setMonth(data.month);
    } catch {
      if (!current.signal.aborted) { setRetryPage(nextPage); setError(true); }
    } finally {
      if (controller.current === current) setLoading(false);
    }
  }

  useEffect(() => {
    if (mode === 'list') void load(1);
    return () => controller.current?.abort();
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSponsorPage = () => {
    window.open(SPONSOR_URL, '_blank', 'noopener,noreferrer');
    onClose();
  };
  const monthLabel = month ? new Date(`${month}-01T12:00:00+08:00`).toLocaleDateString(i18n.resolvedLanguage || i18n.language, { year: 'numeric', month: 'long', timeZone: 'Asia/Shanghai' }) : '';

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85vh] min-w-0 overflow-y-auto sm:max-w-lg" showCloseButton={!confirming}>
      {confirming ? <>
        <DialogHeader><DialogTitle>{t('sponsors.leaveTitle')}</DialogTitle><DialogDescription>{t('sponsors.leaveDescription')}</DialogDescription></DialogHeader>
        <p className="break-all rounded-rect border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">{SPONSOR_URL}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => mode === 'list' ? setConfirming(false) : onClose()}>{t('common.cancel')}</Button>
          <Button onClick={openSponsorPage}>{t('sponsors.confirmLeave')}</Button>
        </div>
      </> : <>
        <DialogHeader><DialogTitle>{t('sponsors.title')}</DialogTitle><DialogDescription>{t('sponsors.description')}</DialogDescription></DialogHeader>
        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{page === 0 ? t('sponsors.loading') : `${monthLabel} ${t(hasMore ? 'sponsors.loaded' : 'sponsors.total', { count: supporters.length })}`}</span><span>{t('sponsors.source')}</span></div>
        <div className="grid max-h-[45vh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {supporters.map((supporter, index) => <div key={`${page}-${index}-${supporter.name}`} className="min-w-0 rounded-rect border border-border px-3 py-2 text-sm [overflow-wrap:anywhere]">{supporter.name}</div>)}
        </div>
        {!loading && !error && supporters.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t(hasMore ? 'sponsors.emptyMore' : 'sponsors.empty')}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{t('sponsors.loadError')}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {loading && <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('sponsors.loading')}</span>}
            {error && <Button variant="outline" size="sm" onClick={() => void load(retryPage)}>{t('sponsors.retry')}</Button>}
            {!error && !loading && hasMore && <Button variant="outline" size="sm" onClick={() => void load(page + 1)}>{t('sponsors.more')}</Button>}
          </div>
          <Button size="sm" onClick={() => setConfirming(true)}><Heart className="size-4" />{t('sponsors.donate')}</Button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
