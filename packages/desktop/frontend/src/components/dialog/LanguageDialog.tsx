import { useRef, useState } from 'react';

import { LanguagePickerContent } from './LanguagePickerContent';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { LANGUAGE_OPTIONS, normalizeLanguage, setAppLanguage } from '@/i18n';
import { useTranslation } from '@/i18n/useI18n';

const order = ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'it', 'ar', 'es', 'pt', 'ru', 'hi', 'lzh'];
const orderedOptions = [...LANGUAGE_OPTIONS].sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));

export function LanguageDialog({ onClose }: { onClose: () => void }) {
  const { i18n, t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');
  const current = normalizeLanguage(i18n.language) ?? 'en';
  const query = search.trim().normalize('NFKC').toLocaleLowerCase();
  const options = orderedOptions.filter(option =>
    `${option.value} ${option.nativeName} ${option.englishName} ${option.chineseName} ${option.aliases} ${t(`settings.general.language.${option.key}`, { defaultValue: option.nativeName })}`
      .normalize('NFKC').toLocaleLowerCase().includes(query),
  ).map(option => ({ value: option.value, name: option.nativeName }));
  const selectLanguage = async (value: string) => {
    const language = normalizeLanguage(value);
    if (busy || !language) return;
    setBusy(true);
    setError(false);
    try { await setAppLanguage(language); onClose(); }
    catch { setError(true); setBusy(false); }
  };

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}
      overlayClassName="language-picker-overlay z-[110]"
      className="language-picker-panel z-[111]"
      onCloseAutoFocus={event => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }}
      onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}>
      <LanguagePickerContent title={<DialogTitle>{t('languageDialog.title')}</DialogTitle>}
        closeLabel={t('languageDialog.close')} searchLabel={t('languageDialog.search')}
        search={search} onSearch={setSearch} inputRef={input} options={options} current={current}
        busy={busy} error={error ? t('languageDialog.switchError') : null}
        emptyLabel={t('languageDialog.noResults')} onSelect={value => void selectLanguage(value)} onClose={onClose} />
    </DialogContent>
  </Dialog>;
}
