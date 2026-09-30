import { useEffect } from 'react';

/** 首个 React 画面提交后，淡出并移除 HTML 首帧加载层。 */
export function BootSplashCleanup() {
	useEffect(() => {
		const splash = document.getElementById('boot-splash');
		if (!splash) return;
		let frame = 0;
		let timer = 0;
		frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => {
				splash.classList.add('is-leaving');
				if (matchMedia('(prefers-reduced-motion: reduce)').matches) splash.remove();
				else timer = window.setTimeout(() => splash.remove(), 240);
			});
		});
		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(timer);
		};
	}, []);
	return null;
}
