/**
 * 启动登录门槛（全屏）：应用一进来就要求登录/注册，通过后才能进入主界面。
 *
 * 状态机：
 *   checking —— 启动时校验本地 token（logo 呼吸 + 环形 spinner）
 *   login    —— 未登录 / token 失效 → 全屏登录/注册（复用 AccountSection）
 *   success  —— 登录成功过渡（圆圈对勾描边，~1s）
 *   ok       —— 放行渲染主应用
 *
 * 网络异常时保留凭据，显示独立的重试状态；不渲染账户设置或放行工作区。
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import './login-surface.css';

import { BrandLogo, LogoLoader, SuccessCheck } from '@/components/auth/LoginAnimation';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';
import { getToken, delToken, delEmail } from '@/utils/authStore';
import { syncModelsFromCloud } from '@/utils/modelSync';

const API_KEY = 'tora_auth_api';
const DEFAULT_AUTH_API = 'https://tora.ohfun.online';

// 已登录用户不应为了几乎不会打开的账户表单下载验证、头像、套餐等依赖。
// 未登录时仍以同一个启动动画作为短暂 fallback，避免出现空白认证页。
const AccountSection = lazy(async () => ({
  default: (await import('@/components/dialog/AccountSection')).AccountSection,
}));

const authApi = () => (localStorage.getItem(API_KEY) || DEFAULT_AUTH_API).replace(/\/+$/, '');

type Phase = 'checking' | 'unavailable' | 'login' | 'success' | 'ok';
type DesktopAuthResult = { status: 'ok' | 'banned' | 'expired' | 'unavailable' | 'stale' };

export function LoginGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('checking');
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setPhase('checking'); setAttempt(current => current + 1); }, []);

  useEffect(() => {
    if (phase !== 'success') return;
    const timer = setTimeout(() => setPhase('ok'), 1000);
    // 登录成功即同步云端模型列表 → 本地镜像，保证换设备/新登录后
    // core 运行时立即拿到该账号的最新模型配置。
    void syncModelsFromCloud();
    return () => clearTimeout(timer);
  }, [phase]);

  // 登出即时感知：设置窗口里点「退出登录」只清凭证 + 改 AccountSection 本地 state，
  // 不会重走启动校验；这里订阅 authStore 的凭证变化事件，token 一旦为空立即切回登录页。
  useEffect(() => {
    const onAuthChanged = () => {
      setPhase((cur) => (cur === 'ok' && !getToken() ? 'login' : cur));
    };
    window.addEventListener('tora-auth-changed', onAuthChanged);
    return () => window.removeEventListener('tora-auth-changed', onAuthChanged);
  }, []);

  useEffect(() => {
    if (phase !== 'unavailable') return;
    const onOnline = () => retry();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [phase, retry]);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    (async () => {
      const token = getToken();
      if (!token) {
        window.clearTimeout(timer);
        setPhase('login');
        return;
      }
      try {
        const r = await fetch(`${authApi()}/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!alive || token !== getToken()) return;
        if (r.ok) {
          // 确认响应来自认证接口，避免代理错误页被误判为已登录。
          await r.json();
          if (!alive || token !== getToken()) return;
          const desktop = await (window as unknown as { toraWindow?: { refreshAccount?: () => Promise<DesktopAuthResult | void> } }).toraWindow?.refreshAccount?.();
          if (!alive || token !== getToken()) return;
          if (desktop?.status === 'unavailable' || desktop?.status === 'stale') { setPhase('unavailable'); return; }
          if (desktop?.status === 'expired') {
            await delToken(); await delEmail();
            if (alive) setPhase('login');
            return;
          }
          // 恢复已有登录直接进入工作区，成功动画仅用于用户主动登录。
          setPhase('ok');
          void syncModelsFromCloud();
        } else if (r.status === 401 && r.headers.get('content-type')?.includes('application/json')) {
          // 仅服务端确认会话失效时清理；代理/WAF 的 403 不等于登出。
          await delToken();
          await delEmail();
          if (alive) setPhase('login');
        } else {
          // 服务暂时异常不等于凭证失效，保留凭证以便下次重试。
          setPhase('unavailable');
        }
      } catch {
        if (alive) {
          setPhase('unavailable');
        }
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attempt]);

  if (phase === 'ok') return <>{children}</>;

  return (
    <div className="app-wallpaper tora-auth-gate fixed inset-0 z-[100]">
      {phase === 'unavailable' && (
        <div className="flex h-full items-center justify-center p-6">
          <div role="alert" className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
            <div className="mb-6 flex justify-center"><BrandLogo /></div>
            <h2 className="text-base font-semibold leading-relaxed">{t('settings.account.networkWarning')}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t('settings.account.networkRetryHint')}</p>
            <Button className="mt-6" onClick={retry}>{t('error.retry')}</Button>
          </div>
        </div>
      )}

      {phase === 'checking' && (
        <div className="flex h-full items-center justify-center">
          <LogoLoader />
        </div>
      )}

      {phase === 'success' && (
        <div className="flex h-full animate-in fade-in flex-col items-center justify-center text-primary">
          <SuccessCheck size={80} />
        </div>
      )}

      {phase === 'login' && (
        <div className="h-full w-full">
          <span className="pointer-events-none absolute left-28 top-3 z-30 px-2 py-1 text-lg font-semibold tracking-[-0.045em] text-foreground">Cognitic</span>
          <Suspense fallback={<div className="flex h-full items-center justify-center"><LogoLoader /></div>}>
            <AccountSection mode="auth" onAuthenticated={() => setPhase('success')} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
