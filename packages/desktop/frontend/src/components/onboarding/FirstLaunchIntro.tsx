import { useState } from 'react';

import { FIRST_RUN_INTRO_KEY } from './constants';
import { useTranslation } from '@/i18n/useI18n';

function isDesktop(): boolean {
	return typeof window !== 'undefined' && Boolean((window as { toraWindow?: unknown }).toraWindow);
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

	const enter = () => {
		try { localStorage.setItem(FIRST_RUN_INTRO_KEY, '1'); }
		catch { /* 存储不可用时允许继续，不让欢迎页变成门槛。 */ }
		setActive(false);
	};

	if (!active) return <>{children}</>;

	return (
		<div className="first-launch-root" role="dialog" aria-modal="true" aria-label={t('firstRun.intro.aria')}>
			<button type="button" className="first-launch-skip" onClick={enter}>{t('firstRun.intro.skip')}</button>
			<div className="first-launch-frame">
				<section className="first-launch-story">
					<div className="first-launch-eyebrow">{t('firstRun.intro.welcome')}</div>
					<h1><span>{t('firstRun.intro.headlineFirst')}</span><span>{t('firstRun.intro.headlineSecond')}</span></h1>
					<p className="first-launch-description">{t('firstRun.intro.description')}</p>
					<div className="first-launch-actions">
						<button type="button" className="first-launch-enter" onClick={enter} autoFocus>{t('firstRun.intro.enter')} <span aria-hidden="true">↗</span></button>
						<span className="first-launch-hint">{t('firstRun.intro.hint')}</span>
					</div>
				</section>
				<div className="first-launch-art">
					<div className="first-launch-logo"><img src="/icon.png" width="512" height="512" alt={t('firstRun.intro.logoAlt')} /></div>
				</div>
			</div>
			<div className="first-launch-foot">{t('firstRun.intro.foot')}</div>
		</div>
	);
}
