/**
 * 启动登录门槛（全屏）：应用一进来就要求登录/注册，通过后才能进入主界面。
 *
 * 状态机：
 *   checking —— 启动时校验本地 token（logo 呼吸 + 环形 spinner）
 *   login    —— 未登录 / token 失效 → 全屏登录/注册（复用 AccountSection）
 *   success  —— 登录成功过渡（圆圈对勾描边，~1s）
 *   ok       —— 放行渲染主应用
 *
 * 网络异常（auth 服务不可达）时保守进入 login 态并在顶部提示，用户仍可尝试
 * 登录（登录请求本身失败会显示错误）。
 */
import { lazy, Suspense, useEffect, useState } from 'react';

import { LogoLoader, SuccessCheck } from '@/components/auth/LoginAnimation';
import { useTranslation } from '@/i18n/useI18n';
import { getToken, delToken, delEmail } from '@/utils/authStore';
import { syncModelsFromCloud } from '@/utils/modelSync';

const API_KEY = 'cocode_auth_api';
const DEFAULT_AUTH_API = 'https://cocode.ohfun.online';

// 已登录用户不应为了几乎不会打开的账户表单下载验证、头像、套餐等依赖。
// 未登录时仍以同一个启动动画作为短暂 fallback，避免出现空白认证页。
const AccountSection = lazy(async () => ({
  default: (await import('@/components/dialog/AccountSection')).AccountSection,
}));

const authApi = () => (localStorage.getItem(API_KEY) || DEFAULT_AUTH_API).replace(/\/+$/, '');

type Phase = 'checking' | 'login' | 'success' | 'ok';

export function LoginGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('checking');
  const [netError, setNetError] = useState(false);

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
    window.addEventListener('cocode-auth-changed', onAuthChanged);
    return () => window.removeEventListener('cocode-auth-changed', onAuthChanged);
  }, []);

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
        if (!alive) return;
        if (r.ok) {
          // 恢复已有登录直接进入工作区，成功动画仅用于用户主动登录。
          setPhase('ok');
          void syncModelsFromCloud();
        } else if (r.status === 401 || r.status === 403) {
          // 401 等：token 失效，清掉重新登录
          await delToken();
          await delEmail();
          if (alive) setPhase('login');
        } else {
          // 服务暂时异常不等于凭证失效，保留凭证以便下次重试。
          setNetError(true);
          setPhase('login');
        }
      } catch {
        if (alive) {
          setNetError(true);
          setPhase('login');
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
  }, []);

  if (phase === 'ok') return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[100] bg-background">
      {netError && phase === 'login' && (
        <div className="absolute left-1/2 top-5 z-20 -translate-x-1/2 rounded-rect bg-destructive-soft px-4 py-1.5 text-xs text-destructive">
          {t('settings.account.networkWarning')}
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
            <AccountSection onAuthenticated={() => setPhase('success')} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
