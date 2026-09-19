/**
 * Cloudflare Turnstile 人机验证组件（登录/注册受保护入口共用）。
 *
 * 显式渲染模式：动态加载 api.js?render=explicit，挂载时 render() 出 widget，
 * 拿到一次性 token 通过 onToken 回传父组件（作为 cf-turnstile-response 提交）。
 * token 一次性——提交失败后父组件通过 ref 调 reset()：widget 重新出挑战，
 * 通过后 onToken 会带新 token 再次回调。
 *
 * sitekey 是公开值（widget 已在 Cloudflare 创建，域名绑定 127.0.0.1/localhost/
 * ohfun.online）；secret 只在 Worker 后端，前端不可见。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export const TURNSTILE_SITEKEY = '0x4AAAAAAE2FjA84FfwMA5BX';
const API_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
	render: (el: HTMLElement, opts: Record<string, unknown>) => string;
	reset: (id?: string) => void;
	remove: (id?: string) => void;
}
declare global {
	interface Window { turnstile?: TurnstileApi }
}

let apiPromise: Promise<TurnstileApi> | null = null;
const ONLOAD_FN = '__cocodeTurnstileOnload';
function loadTurnstileApi(): Promise<TurnstileApi> {
	// 已就绪：必须是带 render 的真 API（不能用 truthy 判断——历史版本曾把
	// window.turnstile 覆盖成 {onload} 占位对象，导致 api.js 不再安装真 API，
	// render undefined、widget 渲染为空白的 bug）。
	if (typeof window.turnstile?.render === 'function') return Promise.resolve(window.turnstile);
	if (!apiPromise) {
		apiPromise = new Promise<TurnstileApi>((resolve, reject) => {
			// 官方显式渲染加载法：?render=explicit&onload=<全局函数名>。
			// api.js 执行完后调用该函数，此时 window.turnstile 已是真 API。
			(window as unknown as Record<string, () => void>)[ONLOAD_FN] = () => {
				if (typeof window.turnstile?.render === 'function') resolve(window.turnstile);
				else { apiPromise = null; reject(new Error('Turnstile API 初始化异常')); }
			};
			const el = document.createElement('script');
			el.src = `${API_SRC}&onload=${ONLOAD_FN}`;
			el.async = true;
			el.defer = true;
			el.onerror = () => { apiPromise = null; reject(new Error('Turnstile 脚本加载失败')); };
			document.head.appendChild(el);
		});
	}
	return apiPromise;
}

export interface TurnstileHandle {
	/** 提交失败后重置 widget 换新 token */
	reset: () => void;
}

export const Turnstile = forwardRef<TurnstileHandle, {
	action: string;
	onToken: (token: string) => void;
}>(({ action, onToken }, ref) => {
	const boxRef = useRef<HTMLDivElement>(null);
	const widgetIdRef = useRef<string | null>(null);

	useImperativeHandle(ref, () => ({
		reset: () => {
			onToken('');
			if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
		},
	}));

	useEffect(() => {
		let disposed = false;
		let id: string | null = null;
		void loadTurnstileApi().then((ts) => {
			if (disposed || !boxRef.current) return;
			id = ts.render(boxRef.current, {
				sitekey: TURNSTILE_SITEKEY,
				action,
				theme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
				callback: (token: string) => { if (!disposed) onToken(token); },
			});
			widgetIdRef.current = id;
		}).catch(() => { /* 加载失败：提交时后端会拒绝并提示重试 */ });
		return () => {
			disposed = true;
			widgetIdRef.current = null;
			if (id) window.turnstile?.remove(id);
		};
		// action 固定（login/register），每个受保护入口独立挂载，无需响应式重建
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return <div ref={boxRef} className="mt-4 flex min-h-[65px] items-center justify-center" />;
});
Turnstile.displayName = 'Turnstile';
