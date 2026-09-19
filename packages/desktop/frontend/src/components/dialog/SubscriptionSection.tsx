/**
 * 设置窗口「订阅」板块。
 *
 * 布局参考 TRAE 订阅页：顶部用户信息条（头像/用户名/积分余额），
 * 中部三档订阅卡片（Lite/Pro/Max），底部支付区（爱发电二维码 +
 * 前往爱发电链接 + 订单号兑换）。
 *
 * 后端：
 *   GET  /auth/me      → { email, username, avatar, credits }
 *   GET  /auth/credits → { balance, transactions }
 *   POST /auth/redeem  { orderNo } → { ok, credits, balance }
 */
import { Check, ChevronRight, ExternalLink, Globe, Loader2, Sparkles, Ticket } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { emitCreditsChanged } from '@/hooks/useCreditsBalance';
import { useTranslation } from '@/i18n/useI18n';
import { requestPanel } from '@/lib/openPanel';
import { getEmail, getToken, getUsername } from '@/utils/authStore';
import { cloudFetch } from '@/utils/modelSync';

const AFD_URL = 'https://ifdian.net/a/zhenxun111';

interface PlanDef {
	key: string;
	name: string;
	price: number;
	credits: number;
	desc: string;
	highlight?: boolean;
}

const PLANS: PlanDef[] = [
	{ key: 'lite', name: 'CoCode Plan - Lite', price: 39, credits: 2000, desc: 'subscription.plans.liteDesc' },
	{ key: 'pro', name: 'CoCode Plan - Pro', price: 99, credits: 6000, desc: 'subscription.plans.proDesc', highlight: true },
	{ key: 'max', name: 'CoCode Plan - Max', price: 299, credits: 25000, desc: 'subscription.plans.maxDesc' },
];

/** 判断是否在 Electron 桌面端（决定是否展示「内置浏览器」选项）。 */
function isElectron() {
	return /Electron/i.test(navigator.userAgent);
}

interface UserInfo {
	email: string;
	username?: string | null;
	avatar?: string | null;
	credits?: number;
}

export function SubscriptionSection({ onClose }: { onClose?: () => void }) {
	const { t } = useTranslation();
	const [user, setUser] = useState<UserInfo | null>(() => {
		const email = getEmail();
		return email ? { email, username: getUsername() } : null;
	});
	const [credits, setCredits] = useState<number>(0);
	// 订单兑换
	const [orderNo, setOrderNo] = useState('');
	const [redeeming, setRedeeming] = useState(false);
	const [redeemMsg, setRedeemMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
	// 浏览器选择弹层
	const [showBrowserChoice, setShowBrowserChoice] = useState(false);
	const choiceRef = useRef<HTMLDivElement>(null);

	// 挂载时拉最新用户信息（含积分）
	useEffect(() => {
		if (!getToken()) return;
		let alive = true;
		cloudFetch('/auth/me')
			.then(async (r) => (r.ok ? await r.json() : null))
			.then((b) => {
				if (!alive || !b) return;
				setUser({ email: b.email, username: b.username, avatar: b.avatar });
				setCredits(b.credits ?? 0);
			})
			.catch(() => {});
		return () => { alive = false; };
	}, []);

	// 点击外部关闭浏览器选择弹层
	useEffect(() => {
		if (!showBrowserChoice) return;
		const onDoc = (e: MouseEvent) => {
			if (choiceRef.current && !choiceRef.current.contains(e.target as Node)) {
				setShowBrowserChoice(false);
			}
		};
		document.addEventListener('mousedown', onDoc);
		return () => document.removeEventListener('mousedown', onDoc);
	}, [showBrowserChoice]);

	const openAfadian = async (mode: 'builtin' | 'system') => {
		setShowBrowserChoice(false);
		if (mode === 'system') {
			// main.js 的 setWindowOpenHandler 会把非站内 URL 交给 shell.openExternal
			window.open(AFD_URL, '_blank', 'noopener,noreferrer');
			return;
		}
		// 内置浏览器：先关设置窗，再开右侧浏览器面板并导航
		onClose?.();
		requestPanel('browser');
		// 等面板挂载（桥 window.__cocodeBrowser 出现）后再导航
		const tryNav = (tries = 0) => {
			const bridge = (window as unknown as { __cocodeBrowser?: { call: (a: string, p?: Record<string, unknown>) => Promise<unknown> } }).__cocodeBrowser;
			if (bridge) {
				bridge.call('new_tab', { url: AFD_URL }).catch(() => {});
			} else if (tries < 20) {
				window.setTimeout(() => tryNav(tries + 1), 150);
			}
		};
		tryNav();
	};

	const handleRedeem = async () => {
		const no = orderNo.trim();
		if (!no || redeeming) return;
		setRedeeming(true);
		setRedeemMsg(null);
		try {
			const res = await cloudFetch('/auth/redeem', {
				method: 'POST',
				body: JSON.stringify({ orderNo: no }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`);
			setCredits(body.balance ?? credits);
			// 通知侧边栏积分实时刷新（首次兑换与重复兑换都派发）
			emitCreditsChanged(typeof body.balance === 'number' ? body.balance : undefined);
			const expire = body.subscription?.expireAt ? String(body.subscription.expireAt).slice(0, 10) : '';
			setRedeemMsg({
				type: 'ok',
				text: body.alreadyRedeemed
					? t('subscription.redeem.alreadyRedeemed', { credits: body.credits, balance: body.balance })
					: t('subscription.redeem.success', { credits: body.credits, balance: body.balance, expire }),
			});
			setOrderNo('');
		} catch (e) {
			setRedeemMsg({ type: 'err', text: e instanceof Error ? e.message : String(e) });
		} finally {
			setRedeeming(false);
		}
	};

	const displayName = user?.username || user?.email || '';
	const initial = displayName.trim().charAt(0).toUpperCase() || '?';

	return (
		<div className="flex flex-col gap-5">
			{/* 顶部用户信息条 */}
			<div className="flex items-center gap-4 rounded-xl border border-border bg-card px-5 py-4">
				<div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted">
					{user?.avatar ? (
						<img src={user.avatar} alt="" className="size-full object-cover" draggable={false} />
					) : (
						<span className="text-lg font-semibold text-muted-foreground">{initial}</span>
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm font-semibold">{displayName || t('subscription.guest')}</span>
						<Badge variant="secondary" className="shrink-0">
							<Sparkles className="mr-1 size-3" />
							{credits.toLocaleString()} {t('subscription.credits')}
						</Badge>
					</div>
					<div className="mt-0.5 truncate text-xs text-muted-foreground">
						{t('subscription.creditsHint')}
					</div>
				</div>
			</div>

			{/* 订阅计划 */}
			<div>
				<div className="flex items-center justify-between">
					<h3 className="text-base font-semibold">{t('subscription.title')}</h3>
					<span className="text-xs text-muted-foreground">{t('subscription.oneTime')}</span>
				</div>
				<p className="mt-1 text-xs text-muted-foreground">{t('subscription.subtitle')}</p>

				<div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
					{PLANS.map((plan) => (
						<div
							key={plan.key}
							className={
								'flex flex-col rounded-xl border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ' +
								(plan.highlight ? 'border-primary ring-1 ring-primary/30' : 'border-border')
							}
						>
							<div className="flex items-center justify-between">
								<span className="text-sm font-semibold">{plan.name}</span>
								{plan.highlight && (
									<span className="rounded-rect-sm bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
										{t('subscription.plans.recommended')}
									</span>
								)}
							</div>
							<div className="mt-2 flex items-baseline gap-1">
								<span className="text-2xl font-bold">¥{plan.price}</span>
								<span className="text-xs text-muted-foreground">/ {t('subscription.perUse')}</span>
							</div>
							<div className="mt-1 text-xs text-muted-foreground">{t(plan.desc)}</div>
							<div className="mt-3 flex items-center gap-1.5 text-xs text-foreground">
								<Check className="size-3.5 text-emerald-500" />
								<span>
									{plan.credits.toLocaleString()} {t('subscription.credits')}
								</span>
							</div>
							<Button
								type="button"
								size="sm"
								variant={plan.highlight ? 'default' : 'outline'}
								className="mt-4 w-full"
								onClick={() => setShowBrowserChoice(true)}
							>
								{t('subscription.plans.subscribe')}
								<ChevronRight className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
			</div>

			{/* 支付 / 兑换区 */}
			<div className="rounded-xl border border-border bg-card p-4">
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center">
					<div className="min-w-0 flex-1">
						<div className="text-sm font-medium">{t('subscription.pay.scanTitle')}</div>
						<div className="mt-0.5 text-xs text-muted-foreground">{t('subscription.pay.scanDesc')}</div>

						{/* 浏览器选择弹层 */}
						<div className="relative mt-3" ref={choiceRef}>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setShowBrowserChoice((v) => !v)}
							>
								<ExternalLink className="size-3.5" />
								{t('subscription.pay.openAfadian')}
							</Button>
							{showBrowserChoice && (
								<div className="absolute left-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-popover shadow-lg animate-in fade-in slide-in-from-top-1 duration-150">
									<button
										type="button"
										className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted disabled:opacity-50"
										disabled={!isElectron()}
										onClick={() => void openAfadian('builtin')}
									>
										<Globe className="size-4 text-muted-foreground" />
										<span className="flex-1">{t('subscription.pay.builtinBrowser')}</span>
										{!isElectron() && (
											<span className="text-[10px] text-muted-foreground">{t('subscription.pay.desktopOnly')}</span>
										)}
									</button>
									<button
										type="button"
										className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-muted"
										onClick={() => void openAfadian('system')}
									>
										<ExternalLink className="size-4 text-muted-foreground" />
										<span className="flex-1">{t('subscription.pay.systemBrowser')}</span>
									</button>
								</div>
							)}
						</div>
					</div>
				</div>

				{/* 订单号兑换 */}
				<div className="mt-4 border-t border-border pt-4">
					<div className="flex items-center gap-2 text-sm font-medium">
						<Ticket className="size-4 text-muted-foreground" />
						{t('subscription.redeem.title')}
					</div>
					<div className="mt-0.5 text-xs text-muted-foreground">{t('subscription.redeem.desc')}</div>
					<div className="mt-3 flex items-center gap-2">
						<Input
							value={orderNo}
							onChange={(e) => setOrderNo(e.target.value)}
							placeholder={t('subscription.redeem.placeholder')}
							className="flex-1 font-mono text-xs"
							spellCheck={false}
							onKeyDown={(e) => { if (e.key === 'Enter') void handleRedeem(); }}
						/>
						<Button type="button" size="sm" disabled={!orderNo.trim() || redeeming} onClick={() => void handleRedeem()}>
							{redeeming && <Loader2 className="size-3.5 animate-spin" />}
							{t('subscription.redeem.button')}
						</Button>
					</div>
					{redeemMsg && (
						<div
							className={
								'mt-2 rounded-md px-3 py-2 text-xs ' +
								(redeemMsg.type === 'ok'
									? 'border border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
									: 'border border-destructive/30 bg-destructive-soft text-destructive')
							}
						>
							{redeemMsg.text}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
