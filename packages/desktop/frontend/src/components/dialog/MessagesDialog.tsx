import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Languages, Loader2 } from 'lucide-react';
import { useAccountPresence } from '@/components/auth/AccountPresence';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/useI18n';
import { cloudFetch } from '@/utils/modelSync';

type Message = { id: string; title: string; body: string; created_at: string; read_at: string | null; source_language?: 'zh' | 'en' | null };
type TranslationState = { loading?: boolean; show?: boolean; skipped?: boolean; error?: string; result?: { title: string; body: string } };
function messagePreview(body: string) {
  const characters = Array.from(body.replace(/\s+/g, ' ').trim());
  return characters.slice(0, 80).join('') + (characters.length > 80 ? '…' : '');
}
export function MessagesDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const targetLanguage = (i18n.resolvedLanguage || i18n.language).startsWith('zh') ? 'zh' : 'en';
  const { revision } = useAccountPresence();
  const [messages, setMessages] = useState<Message[]>([]);
  const [offset, setOffset] = useState<number | null>(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Message | null>(null);
  const [translations, setTranslations] = useState<Record<string, TranslationState>>({});
  const inFlight = useRef(new Set<string>());
  const recalled = useRef(new Set<string>());
  const loadVersion = useRef(0);
  const selectedRef = useRef<Message | null>(null);
  selectedRef.current = selected;
  const translationKey = (message: Message) => `${message.id}:${targetLanguage}`;
  const displayed = (message: Message) => {
    const state = translations[translationKey(message)];
    return state?.show && state.result ? state.result : message;
  };
  async function translate(message: Message) {
    const key = translationKey(message);
    const state = translations[key];
    if (inFlight.current.has(key) || message.source_language === targetLanguage) return;
    if (state?.result) {
      setTranslations(previous => ({ ...previous, [key]: { ...previous[key], show: !previous[key]?.show } }));
      return;
    }
    inFlight.current.add(key);
    setTranslations(previous => ({ ...previous, [key]: { loading: true } }));
    try {
      const response = await cloudFetch('/account/messages/translate', {
        method: 'POST', body: JSON.stringify({ id: message.id, targetLanguage }), signal: AbortSignal.timeout(75000),
      });
      const data = await response.json();
      if (recalled.current.has(message.id)) return;
      if (!response.ok) throw new Error(data.code === 'TRANSLATION_RATE_LIMIT' ? 'translationRateLimit' : 'translationError');
      if (data.translated && (data.targetLanguage !== targetLanguage || typeof data.title !== 'string' || typeof data.body !== 'string')) throw new Error('translationError');
      setTranslations(previous => ({ ...previous, [key]: data.translated ? { result: { title: data.title, body: data.body }, show: true } : { skipped: true } }));
    } catch (error) {
      setTranslations(previous => ({ ...previous, [key]: { error: error instanceof Error && error.message === 'translationRateLimit' ? 'translationRateLimit' : 'translationError' } }));
    } finally { inFlight.current.delete(key); }
  }
  function translationControl(message: Message) {
    const state = translations[translationKey(message)];
    const unnecessary = message.source_language === targetLanguage || message.source_language === null || state?.skipped;
    return <div className="space-y-1">
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" disabled={!!unnecessary || state?.loading} onClick={() => void translate(message)}>
        {state?.loading ? <Loader2 className="size-3.5 animate-spin" /> : <Languages className="size-3.5" />}
        {t(`inbox.${state?.loading ? 'translating' : unnecessary ? 'noTranslationNeeded' : state?.show ? 'showOriginal' : state?.result ? 'showTranslation' : targetLanguage === 'zh' ? 'translateToChinese' : 'translateToEnglish'}`)}
      </Button>
      {state?.error && <p role="alert" className="text-xs text-destructive">{t(`inbox.${state.error}`)}</p>}
    </div>;
  }
  async function load(more = false) {
    const version = ++loadVersion.current;
    setLoading(true); setError('');
    try {
      const response = await cloudFetch('/account/messages?offset=' + (more ? offset : 0));
      const data = await response.json();
      if (version !== loadVersion.current) return;
      if (!response.ok) throw new Error(data.detail || t('inbox.loadError'));
      setMessages(previous => more ? [...previous, ...data.messages] : data.messages);
      setOffset(data.nextOffset);
      const current = selectedRef.current;
      if (current && !data.messages.some((item: Message) => item.id === current.id)) {
        const detail = await cloudFetch('/account/messages/' + encodeURIComponent(current.id));
        if (version !== loadVersion.current) return;
        if (detail.status === 404) {
          recalled.current.add(current.id);
          setSelected(value => value?.id === current.id ? null : value);
          setTranslations(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(current.id + ':'))));
        }
      }
    } catch (e) { setError(e instanceof Error ? e.message : t('inbox.loadError')); }
    finally { if (version === loadVersion.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  async function open(message: Message) {
    setSelected(message);
    if (message.read_at) return;
    try {
      const response = await cloudFetch('/account/messages/read', { method: 'POST', body: JSON.stringify({ ids: [message.id] }) });
      if (!response.ok) throw new Error(t('inbox.readError'));
      setMessages(items => items.map(item => item.id === message.id ? { ...item, read_at: new Date().toISOString() } : item));
    } catch { setError(t('inbox.readError')); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="min-w-0 max-h-[80vh] grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto sm:max-w-xl">
      <DialogHeader className="min-w-0 pr-8"><DialogTitle>{t(selected ? 'inbox.detail' : 'inbox.title')}</DialogTitle></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => void load()}>{t('inbox.retry')}</Button></p>}
      {selected ? <article className="min-w-0 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>← {t('inbox.back')}</Button>
        <h2 className="text-base font-medium [overflow-wrap:anywhere]">{displayed(selected).title}</h2>
        <time className="text-xs text-muted-foreground">{new Date(selected.created_at).toLocaleString()}</time>
        <p className="whitespace-pre-wrap text-sm leading-7 [overflow-wrap:anywhere]">{displayed(selected).body}</p>
        {translationControl(selected)}
      </article> : <div className="min-w-0 space-y-2">
        {!messages.length && <p className="py-10 text-center text-sm text-muted-foreground">{loading ? t('inbox.loading') : t('inbox.empty')}</p>}
        {messages.map(message => <button key={message.id} onClick={() => void open(message)} className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{message.title}</span>{!message.read_at && <span aria-label={t('inbox.unread')} className="size-2 shrink-0 rounded-full bg-foreground" />}</div>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{messagePreview(message.body)}</p>
            <time className="mt-2 block text-xs text-muted-foreground">{new Date(message.created_at).toLocaleString(i18n.resolvedLanguage, { dateStyle: 'short', timeStyle: 'short' })}</time>
          </div>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>)}
        {offset !== null && messages.length > 0 && <Button variant="ghost" disabled={loading} onClick={() => void load(true)}>{t('inbox.more')}</Button>}
      </div>}
    </DialogContent>
  </Dialog>;
}
