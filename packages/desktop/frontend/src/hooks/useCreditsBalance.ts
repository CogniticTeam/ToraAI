/**
 * 侧边栏积分余额：挂载拉取 /auth/me，登录态变化重拉。
 * 更新三层：core 在官方模型扣费落账后推 'credits_changed' SSE 事件 →
 * useMessages 转发实际扣减额，先本地同步显示、再用权威余额校准；
 * 兑换等渲染层变动直接带余额派发（零延迟）；5s 轮询兜底
 * （覆盖不经 SSE 的链路与偶发漏网）。
 *
 * 事件约定：
 *   window 'cocode-credits-changed' detail.balance 为 number 时直接采用；
 *   detail.debit 为 number 时先立即从当前余额扣除，随后重新拉取校准。
 */
import { useCallback, useEffect, useState } from 'react';

import { getToken } from '@/utils/authStore';
import { cloudFetch } from '@/utils/modelSync';

export const CREDITS_CHANGED_EVENT = 'cocode-credits-changed';

export interface CreditsChange {
	balance?: number;
	/** 已由服务端确认、本次应从显示余额中立即扣除的积分。 */
	debit?: number;
}

/** 积分变动处调用：余额可直接替换；扣减额先乐观显示后由服务端校准。 */
export function emitCreditsChanged(change?: number | CreditsChange) {
	if (typeof window === 'undefined') return;
	const detail = typeof change === 'number' ? { balance: change } : (change ?? {});
	window.dispatchEvent(new CustomEvent(CREDITS_CHANGED_EVENT, { detail }));
}

export function useCreditsBalance() {
	const [state, setState] = useState<{ signedIn: boolean; credits: number | null }>({
		signedIn: false,
		credits: null,
	});

	const refresh = useCallback(async () => {
		if (!getToken()) {
			setState({ signedIn: false, credits: null });
			return;
		}
		try {
			const r = await cloudFetch('/auth/me');
			if (!r.ok) return;
			const b = await r.json();
			setState({ signedIn: true, credits: typeof b.credits === 'number' ? b.credits : null });
		} catch {
			// 网络失败保留现有值，等下次轮询
		}
	}, []);

	useEffect(() => {
		void refresh();
		// 扣费落账（网关流 flush 写 D1）比 core 读完流晚几毫秒，且一轮 run
		// 可能连续多次模型调用——尾沿 250ms 去抖合并刷新，既躲过竞态又省请求。
		let debounce: number | null = null;
		const refreshSoon = () => {
			if (debounce !== null) window.clearTimeout(debounce);
			debounce = window.setTimeout(() => void refresh(), 250);
		};
		const onAuth = () => refreshSoon();
		const onCredits = (e: Event) => {
			const { balance, debit } = (e as CustomEvent<CreditsChange>).detail ?? {};
			if (typeof balance === 'number') setState({ signedIn: true, credits: balance });
			else if (typeof debit === 'number' && debit > 0) {
				setState((previous) => ({
					signedIn: true,
					credits: previous.credits === null ? null : Math.max(0, previous.credits - debit),
				}));
				// 乐观值展示后尽快以 Worker 的真实余额校准，处理并发消费/透支。
				refreshSoon();
			} else refreshSoon();
		};
		window.addEventListener('cocode-auth-changed', onAuth);
		window.addEventListener(CREDITS_CHANGED_EVENT, onCredits);
		const timer = window.setInterval(() => void refresh(), 5_000);
		return () => {
			if (debounce !== null) window.clearTimeout(debounce);
			window.removeEventListener('cocode-auth-changed', onAuth);
			window.removeEventListener(CREDITS_CHANGED_EVENT, onCredits);
			window.clearInterval(timer);
		};
	}, [refresh]);

	return state;
}
