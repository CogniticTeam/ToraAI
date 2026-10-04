import { useTranslation } from '@/i18n/useI18n';
import { openSettings } from '@/lib/openSettings';
import type { AgentQuota } from '@/lib/tochatModels';
export function AgentQuotaMeter({ quota, compact = false }: { quota?: AgentQuota | null; compact?: boolean }) {
 const { t } = useTranslation();
 if (!quota) return <span className="text-xs text-muted-foreground">{t('applicationModes.quotaLoading')}</span>;
 const percent = Math.max(0, Math.min(100, quota.remainingPercent || 0));
 const bars = compact ? [{ key: 'remaining', remainingPercent: percent, resetAt: null }] : quota.windows;
 return <div className={compact ? 'min-w-24 space-y-1' : 'space-y-3'}>
  {!compact && <p className="text-sm font-medium">{quota.subscription?.name ?? t('subscription.none')}</p>}
  {bars.map(window => <div key={window.key} className="space-y-1">
   <div className="flex items-center justify-between gap-3 text-xs"><span>{t(`subscription.${window.key}`)}</span><span>{(window.remainingPercent>0?Math.max(0.1,window.remainingPercent):0).toFixed(1)}%</span></div>
   <div role="progressbar" aria-label={t(`subscription.${window.key}`)} aria-valuenow={Number((window.remainingPercent>0?Math.max(0.1,window.remainingPercent):0).toFixed(1))} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${window.remainingPercent}%` }} /></div>
   {!compact && window.resetAt && <p className="text-xs text-muted-foreground">{t('subscription.nextRelease', { time: new Date(window.resetAt).toLocaleString() })}</p>}
  </div>)}
  {!compact && <><p className="text-xs text-muted-foreground">{t('subscription.shared')}</p><button type="button" className="text-xs underline underline-offset-4" onClick={() => openSettings('account')}>{t('subscription.manage')}</button></>}
 </div>;
}
