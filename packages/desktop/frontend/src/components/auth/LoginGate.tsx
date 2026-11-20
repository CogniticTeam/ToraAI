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
import { authBaseURL as authApi } from '@/lib/toraService';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import './login-surface.css';

import { BrandLogo, LogoLoader, SuccessCheck } from '@/components/auth/LoginAnimation';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';
import { getToken, delToken, delEmail } from '@/utils/authStore';
import { signOutAccount } from '@/utils/authLogout';
import { syncModelsFromCloud } from '@/utils/modelSync';


// 已登录用户不应为了几乎不会打开的账户表单下载验证、头像、套餐等依赖。
// 未登录时仍以同一个启动动画作为短暂 fallback，避免出现空白认证页。
const AccountSection = lazy(async () => ({
  default: (await import('@/components/dialog/AccountSection')).AccountSection,
}));


type Phase = 'checking' | 'unavailable' | 'blocked' | 'login' | 'success' | 'ok';
type DesktopAuthResult = { status: 'ok' | 'banned' | 'expired' | 'unavailable' | 'stale' };

function desktopAccount() {
  return (window as unknown as { toraWindow?: { refreshAccount?: () => Promise<DesktopAuthResult | void> } }).toraWindow;
}

export function LoginGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('checking');
  const [attempt, setAttempt] = useState(0);
  const interactiveToken = useRef<string | null>(null);
  const retry = useCallback(() => { setPhase('checking'); setAttempt(current => current + 1); }, []);

  useEffect(() => {
    if (phase !== 'success') return;
    const timer = setTimeout(() => setPhase(getToken() ? 'ok' : 'login'), 1000);
    // 登录成功即同步云端模型列表 → 本地镜像，保证换设备/新登录后
    // core 运行时立即拿到该账号的最新模型配置。
    void syncModelsFromCloud();
    return () => clearTimeout(timer);
  }, [phase]);

  // 登出即时感知：设置窗口里点「退出登录」只清凭证 + 改 AccountSection 本地 state，
  // 不会重走启动校验；这里订阅 authStore 的凭证变化事件，token 一旦为空立即切回登录页。
  useEffect(() => {
    const onAuthChanged = () => {
      if (!getToken()) {
        interactiveToken.current = null;
        setPhase('login');
      }
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
    const bridge = desktopAccount();
    const timer = window.setTimeout(() => controller.abort(), bridge?.refreshAccount ? 12000 : 8000);
    (async () => {
      const token = getToken();
      if (!token) {
        window.clearTimeout(timer);
        setPhase('login');
        return;
      }
      const isCurrent = () => {
        if (!alive) return false;
        const current = getToken();
        if (current === token) return true;
        if (current) retry();
        else setPhase('login');
        return false;
      };
      try {
        const desktop = bridge?.refreshAccount ? await Promise.race([
          bridge.refreshAccount(),
          new Promise<DesktopAuthResult>(resolve => {
            controller.signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true });
          }),
        ]) : undefined;
        if (!isCurrent()) return;
        let status = desktop?.status;
        if (!status) {
          const r = await fetch(`${authApi()}/auth/me`, {
            headers: { authorization: `Bearer ${token}` }, signal: controller.signal,
          });
          if (r.ok) {
            const profile = await r.json();
            status = profile.banned ? 'banned' : 'ok';
          } else {
            status = r.status === 401 && r.headers.get('content-type')?.includes('application/json') ? 'expired' : 'unavailable';
          }
          if (!isCurrent()) return;
        }
        if (status === 'expired') {
          await delToken();
          await delEmail();
          if (alive) setPhase('login');
        } else if (status === 'banned') {
          setPhase('blocked');
        } else if (status === 'ok') {
          const animate = interactiveToken.current === token;
          interactiveToken.current = null;
          setPhase(animate ? 'success' : 'ok');
          if (!animate) void syncModelsFromCloud();
        } else {
          setPhase('unavailable');
        }
      } catch {
        if (isCurrent()) setPhase('unavailable');
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, retry]);

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

      {phase === 'blocked' && (
        <div className="flex h-full items-center justify-center p-6">
          <div role="alert" className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
            <h2 className="text-base font-semibold">{t('inbox.blocked')}</h2>
            <p className="mt-3 text-sm text-muted-foreground">{t('inbox.blockedReason')}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button onClick={retry}>{t('error.retry')}</Button>
              <Button variant="outline" onClick={() => void signOutAccount()}>{t('inbox.signOut')}</Button>
            </div>
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
          <Suspense fallback={<div className="flex h-full items-center justify-center"><LogoLoader /></div>}>
            <AccountSection mode="auth" onAuthenticated={() => {
              if (desktopAccount()?.refreshAccount) {
                interactiveToken.current = getToken();
                retry();
              } else {
                setPhase('success');
              }
            }} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
