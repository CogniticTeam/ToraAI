import { createContext, useContext, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@/i18n/useI18n';
import { clearAll, getToken } from '@/utils/authStore';
import { cloudApi, cloudFetch } from '@/utils/modelSync';

const AccountContext = createContext({ unread: 0, revision: 0 });
export const useAccountPresence = () => useContext(AccountContext);

export function AccountPresence({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [token, setToken] = useState(getToken);
  const [blocked, setBlocked] = useState(false);
  const [reason, setReason] = useState('');
  const [unread, setUnread] = useState(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setToken(getToken());
    window.addEventListener('cocode-auth-changed', changed);
    return () => window.removeEventListener('cocode-auth-changed', changed);
  }, []);
  useEffect(() => {
    let alive = true;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    let checkAgain = false;
    let lastPong = Date.now();
    let attempt = 0;
    const controller = new AbortController();
    setBlocked(false); setReason(''); setUnread(0);
    if (!token) return;
    const desktop = (window as unknown as { cocodeWindow?: { refreshAccount?: () => Promise<unknown> } }).cocodeWindow;
    async function refresh() {
      if (checking) { checkAgain = true; return; }
      checking = true;
      try {
        const response = await cloudFetch('/auth/me', { signal: controller.signal });
        if (!alive) return;
        if (response.status === 401) { await clearAll(); return; }
        if (!response.ok) return;
        const account = await response.json();
        if (!alive) return;
        setBlocked(!!account.banned); setReason(account.banReason || '');
        // 主进程独立向服务器确认，暂停正在运行的任务并阻止新任务。
        void desktop?.refreshAccount?.();
        const messages = await cloudFetch('/account/messages', { signal: controller.signal });
        if (messages.ok) {
          const data = await messages.json();
          if (alive) { setUnread(data.unread || 0); setRevision(value => value + 1); }
        }
      } catch { /* 断网保留上次状态，重连后同步。 */ }
      finally {
        checking = false;
        if (alive && checkAgain) { checkAgain = false; void refresh(); }
      }
    }
    async function connect() {
      if (!alive) return;
      try {
        const response = await cloudFetch('/account/events-ticket', { method: 'POST', signal: controller.signal });
        if (response.status === 401) { await clearAll(); return; }
        if (!response.ok) throw new Error('Realtime unavailable');
        const { ticket } = await response.json();
        if (!alive) return;
        const url = new URL(cloudApi() + '/account/events');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('ticket', ticket);
        socket = new WebSocket(url);
        socket.onopen = () => { attempt = 0; lastPong = Date.now(); void refresh(); };
        socket.onmessage = (message) => {
          lastPong = Date.now();
          if (message.data === 'pong') return;
          try {
            const event = JSON.parse(message.data);
            if (event.type === 'messages-changed') setRevision(value => value + 1);
            if (event.type === 'message-received') {
              setRevision(value => value + 1);
              toast(t('inbox.newMessage'));
            }
            void refresh();
          } catch { /* 忽略非协议消息。 */ }
        };
        socket.onclose = retry;
        socket.onerror = () => socket?.close();
      } catch { retry(); }
    }
    function retry() {
      if (!alive) return;
      clearTimeout(reconnect);
      reconnect = setTimeout(connect, Math.min(15000, 1000 * 2 ** attempt++));
    }
    void refresh(); void connect();
    const interval = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        if (Date.now() - lastPong > 45000) socket.close();
        else socket.send('ping');
      }
      // 短轮询兜底断线；正常连接仅定期校验会话。
      if (socket?.readyState !== WebSocket.OPEN) void refresh();
    }, 5000);
    const validation = setInterval(() => void refresh(), 60000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => { alive = false; controller.abort(); clearTimeout(reconnect); clearInterval(interval); clearInterval(validation); socket?.close(); window.removeEventListener('focus', focus); };
  }, [token, t]);
  return <AccountContext.Provider value={{ unread, revision }}>
    {!blocked && children}
    {blocked && <div role="alertdialog" aria-modal="true" aria-labelledby="account-blocked-title" className="fixed inset-0 z-[250] grid place-items-center bg-background p-8">
      <div className="max-w-md space-y-5 text-center">
        <h1 id="account-blocked-title" className="text-xl font-medium">{t('inbox.blocked')}</h1>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{reason || t('inbox.blockedReason')}</p>
        <p className="text-xs text-muted-foreground">{t('inbox.unbanHint')}</p>
        <button className="rounded-xl border border-border px-4 py-2 text-sm" onClick={() => void clearAll()}>{t('inbox.signOut')}</button>
      </div>
    </div>}
  </AccountContext.Provider>;
}
