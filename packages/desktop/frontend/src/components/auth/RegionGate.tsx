/**
 * 中国大陆用户合规告知层。
 * 启动时通过 auth-worker /geo（Cloudflare request.cf.country，随客户端 IP 注入）
 * 判定归属地：若为中国大陆，则在应用之上覆盖一层不可绕过的境外传输告知，
 * 仅提供「同意并继续使用」一个出口；不同意 = 关闭应用（告知文案中已说明）。
 * 同意记录存 localStorage，之后启动不再弹出。检测失败/超时不拦截用户。
 */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';

const AGREED_KEY = 'cocode_cn_notice_agreed_v1';
const GEO_TIMEOUT_MS = 6000;

// 与 AccountSection 同一认证服务（那里是私有常量，这里轻量重复一份）
const geoApi = () => (localStorage.getItem('cocode_auth_api') || 'https://cocode.ohfun.online').replace(/\/+$/, '');

export function RegionGate({ children }: { children: React.ReactNode }) {
	const { t } = useTranslation();
	const [state, setState] = useState<'checking' | 'pass' | 'cn'>(() =>
		localStorage.getItem(AGREED_KEY) ? 'pass' : 'checking');

	useEffect(() => {
		if (state !== 'checking') return;
		const ctrl = new AbortController();
		const timer = window.setTimeout(() => ctrl.abort(), GEO_TIMEOUT_MS);
		fetch(`${geoApi()}/geo`, { signal: ctrl.signal })
			.then((r) => (r.ok ? r.json() : null))
			.then((b) => setState(b?.country === 'CN' ? 'cn' : 'pass'))
			.catch(() => setState('pass'));
		return () => {
			ctrl.abort();
			window.clearTimeout(timer);
		};
	}, [state]);

	if (state !== 'cn') return <>{children}</>;

	return (
		<>
			{children}
			{/* 合规告知：同意前阻断一切交互（含其下的登录界面） */}
			<div className="fixed inset-0 z-[90] flex items-center justify-center bg-background p-6">
				<div className="w-full max-w-md rounded-2xl border border-border bg-popover p-7 shadow-2xl">
					<h2 className="text-lg font-semibold leading-snug">{t('regionNotice.title')}</h2>
					<p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
						{t('regionNotice.body')}
					</p>
					<Button
						type="button"
						className="mt-6 w-full"
						onClick={() => {
							localStorage.setItem(AGREED_KEY, '1');
							setState('pass');
						}}
					>
						{t('regionNotice.agree')}
					</Button>
				</div>
			</div>
		</>
	);
}
