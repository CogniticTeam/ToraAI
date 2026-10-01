import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';

export const FIRST_USE_CONSENT_KEY = 'tora:first-use-consent:v1';
const POLICY_URLS = {
  terms: 'https://ohfun.online/#terms',
  privacy: 'https://ohfun.online/#privacy',
  crossBorder: 'https://ohfun.online/#cross-border',
} as const;

function hasConsent() {
  // 普通浏览器预览没有桌面桥，协议门槛只在 Tora 桌面应用出现。
  if (!(window as { toraWindow?: unknown }).toraWindow) return true;
  try {
    const record = JSON.parse(localStorage.getItem(FIRST_USE_CONSENT_KEY) || 'null');
    return record?.terms === true && record?.privacy === true && record?.crossBorder === true;
  } catch { return false; }
}

export function FirstUseConsent({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [accepted, setAccepted] = useState(hasConsent);
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [crossBorder, setCrossBorder] = useState(false);

  const agree = () => {
    if (!terms || !privacy || !crossBorder) return;
    try {
      localStorage.setItem(FIRST_USE_CONSENT_KEY, JSON.stringify({ terms: true, privacy: true, crossBorder: true, acceptedAt: new Date().toISOString() }));
    } catch { /* 存储不可用时只放行本次会话，下次继续询问。 */ }
    setAccepted(true);
  };

  const decline = () => {
    const bridge = (window as { toraWindow?: { quitApp?: () => void } }).toraWindow;
    if (bridge?.quitApp) bridge.quitApp();
    else window.close();
  };

  if (accepted) return <>{children}</>;

  return <div className="fixed inset-0 z-[180] flex items-center justify-center overflow-y-auto bg-background p-4 text-foreground sm:p-8" role="dialog" aria-modal="true" aria-labelledby="first-use-consent-title">
    <div className="w-full max-w-xl rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-lg sm:p-8">
      <img src="/icon.png" width="44" height="44" alt="" className="mb-5 size-11 rounded-xl" />
      <h1 id="first-use-consent-title" className="text-2xl font-semibold tracking-tight text-popover-foreground">{t('firstUseConsent.title')}</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('firstUseConsent.description')}</p>
      <div className="mt-6 space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-border p-4">
          <input id="consent-terms" type="checkbox" checked={terms} onChange={event => setTerms(event.target.checked)} className="mt-1 size-4 shrink-0 accent-foreground" />
          <div className="min-w-0 flex-1"><label htmlFor="consent-terms" className="cursor-pointer text-sm font-medium text-popover-foreground">{t('firstUseConsent.terms')}</label><a className="mt-1 block w-fit text-xs text-primary underline underline-offset-4" href={POLICY_URLS.terms} target="_blank" rel="noopener noreferrer">{t('firstUseConsent.readTerms')}</a></div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border p-4">
          <input id="consent-privacy" type="checkbox" checked={privacy} onChange={event => setPrivacy(event.target.checked)} className="mt-1 size-4 shrink-0 accent-foreground" />
          <div className="min-w-0 flex-1"><label htmlFor="consent-privacy" className="cursor-pointer text-sm font-medium text-popover-foreground">{t('firstUseConsent.privacy')}</label><a className="mt-1 block w-fit text-xs text-primary underline underline-offset-4" href={POLICY_URLS.privacy} target="_blank" rel="noopener noreferrer">{t('firstUseConsent.readPrivacy')}</a></div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border p-4">
          <input id="consent-cross-border" type="checkbox" checked={crossBorder} onChange={event => setCrossBorder(event.target.checked)} className="mt-1 size-4 shrink-0 accent-foreground" />
          <div className="min-w-0 flex-1"><label htmlFor="consent-cross-border" className="cursor-pointer text-sm font-medium text-popover-foreground">{t('firstUseConsent.crossBorder')}</label><p className="mt-1 text-xs leading-5 text-muted-foreground">{t('firstUseConsent.crossBorderHint')}</p><a className="mt-1 block w-fit text-xs text-primary underline underline-offset-4" href={POLICY_URLS.crossBorder} target="_blank" rel="noopener noreferrer">{t('firstUseConsent.readCrossBorder')}</a></div>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={decline}>{t('firstUseConsent.decline')}</Button>
        <Button onClick={agree} disabled={!terms || !privacy || !crossBorder}>{t('firstUseConsent.agree')}</Button>
      </div>
    </div>
  </div>;
}
