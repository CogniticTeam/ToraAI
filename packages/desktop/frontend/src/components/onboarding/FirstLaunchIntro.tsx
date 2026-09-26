import { useEffect, useState } from 'react';

import { FIRST_RUN_INTRO_KEY, FIRST_RUN_REPLAY_EVENT, FIRST_RUN_STEP_KEY, FIRST_RUN_TOUR_KEY } from './constants';
import { useTranslation } from '@/i18n/useI18n';

function isDesktop(): boolean {
	return typeof window !== 'undefined' && Boolean((window as { cocodeWindow?: unknown }).cocodeWindow);
}

function shouldShowIntro(): boolean {
	if (!isDesktop()) return false;
	try { return localStorage.getItem(FIRST_RUN_INTRO_KEY) !== '1'; }
	catch { return true; }
}

/** 首次启动只展示一次；更新门槛在它外面，必须先处理强制更新。 */
export function FirstLaunchIntro({ children }: { children: React.ReactNode }) {
	const { t } = useTranslation();
	const [active, setActive] = useState(shouldShowIntro);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		if (!active) return;
		setReady(false);
		const delay = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 2900;
		const timer = window.setTimeout(() => setReady(true), delay);
		return () => window.clearTimeout(timer);
	}, [active]);

	useEffect(() => {
		const replay = () => {
			if (!isDesktop()) return;
			try {
				localStorage.removeItem(FIRST_RUN_INTRO_KEY);
				localStorage.removeItem(FIRST_RUN_TOUR_KEY);
				localStorage.removeItem(FIRST_RUN_STEP_KEY);
			} catch { /* 私密模式仍可在本次会话中重播。 */ }
			setActive(true);
		};
		window.addEventListener(FIRST_RUN_REPLAY_EVENT, replay);
		return () => window.removeEventListener(FIRST_RUN_REPLAY_EVENT, replay);
	}, []);

	const enter = () => {
		try { localStorage.setItem(FIRST_RUN_INTRO_KEY, '1'); }
		catch { /* 存储不可用时允许继续，不让欢迎页变成门槛。 */ }
		setActive(false);
	};

	if (!active) return <>{children}</>;

	return (
		<div className={`first-launch-root${ready ? ' first-launch-ready' : ''}`} role="dialog" aria-modal="true" aria-label={t('firstRun.intro.aria')}>
			<div className="first-launch-grid" aria-hidden="true" />
			<div className="first-launch-beam first-launch-beam-a" aria-hidden="true" />
			<div className="first-launch-beam first-launch-beam-b" aria-hidden="true" />
			<div className="first-launch-orbit first-launch-orbit-a" aria-hidden="true" />
			<div className="first-launch-orbit first-launch-orbit-b" aria-hidden="true" />
			<div className="first-launch-orbit first-launch-orbit-c" aria-hidden="true" />
			<div className="first-launch-center">
				<div className="first-launch-mark" aria-hidden="true">‹_</div>
				<h1>CoCode</h1>
				<p>{t('firstRun.intro.tagline')}</p>
				<div className="first-launch-progress" aria-hidden="true"><span /></div>
				<div className="first-launch-status" role="status">{ready ? t('firstRun.intro.ready') : t('firstRun.intro.initializing')}</div>
				<button type="button" className="first-launch-enter" onClick={enter} autoFocus>{t('firstRun.intro.enter')} <span aria-hidden="true">↗</span></button>
			</div>
			<button type="button" className="first-launch-skip" onClick={enter}>{t('firstRun.intro.skip')} <span aria-hidden="true">↗</span></button>
			<span className="first-launch-corner" aria-hidden="true">FIRST LAUNCH · 001</span>
		</div>
	);
}
