import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion';
import { MousePointer2, RotateCcw, ShieldCheck, History } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';

import {
	FIRST_RUN_CLOSE_FOLDER_EVENT,
	FIRST_RUN_CLOSE_MODEL_EVENT,
	FIRST_RUN_CLOSE_PERMISSION_EVENT,
	FIRST_RUN_CLOSE_SETTINGS_EVENT,
	FIRST_RUN_FOLDER_CLOSED_EVENT,
	FIRST_RUN_FOLDER_OPENED_EVENT,
	FIRST_RUN_PERMISSION_CLOSED_EVENT,
	FIRST_RUN_PERMISSION_OPENED_EVENT,
	FIRST_RUN_SETTINGS_CLOSED_EVENT,
	FIRST_RUN_STEP_KEY,
	FIRST_RUN_TOUR_KEY,
} from './constants';
import { useTranslation } from '@/i18n/useI18n';

const TARGETS = [
	'#tour-llm-select', '#tour-add-model', '#tour-workspace-picker',
	'#tour-permission-mode', '#tour-chat-textarea', '#tour-send-button',
	'#first-run-demo-approve', '#first-run-demo-checkpoint',
	'#tour-skills-nav', '#tour-browser-nav', '#tour-automation-nav',
] as const;

type PauseReason = 'settings' | 'folder' | 'permission' | null;
type Rect = { left: number; top: number; width: number; height: number; radius: number };
type Point = { left: number; top: number };
const SPOTLIGHT_SPRING = { stiffness: 340, damping: 32, mass: 0.7 };

function SpotlightMask({ rect, viewport, reducedMotion }: { rect: Rect; viewport: { width: number; height: number }; reducedMotion: boolean }) {
	const x = useSpring(rect.left, SPOTLIGHT_SPRING);
	const y = useSpring(rect.top, SPOTLIGHT_SPRING);
	const width = useSpring(rect.width, SPOTLIGHT_SPRING);
	const height = useSpring(rect.height, SPOTLIGHT_SPRING);
	const radius = useSpring(rect.radius, SPOTLIGHT_SPRING);
	const viewportWidth = useMotionValue(viewport.width);
	const viewportHeight = useMotionValue(viewport.height);
	useLayoutEffect(() => {
		const move = (value: typeof x, next: number) => reducedMotion ? value.jump(next) : value.set(next);
		move(x, rect.left);
		move(y, rect.top);
		move(width, rect.width);
		move(height, rect.height);
		move(radius, rect.radius);
		viewportWidth.set(viewport.width);
		viewportHeight.set(viewport.height);
	}, [rect, viewport, reducedMotion, x, y, width, height, radius, viewportWidth, viewportHeight]);

	// 四片实色遮罩、四个小圆角和描边共用同一组弹簧值，每帧的开口不会错位。
	const right = useTransform(() => x.get() + width.get());
	const bottom = useTransform(() => y.get() + height.get());
	// 遮罩块相互重叠 1px，避免亚像素缩放时在整屏留下亮色接缝。
	const shadeRightX = useTransform(() => right.get() - 1);
	const shadeBottomY = useTransform(() => bottom.get() - 1);
	const shadeBandY = useTransform(() => y.get() - 1);
	const shadeBandHeight = useTransform(() => height.get() + 2);
	const rightWidth = useTransform(() => Math.max(0, viewportWidth.get() - shadeRightX.get()));
	const bottomHeight = useTransform(() => Math.max(0, viewportHeight.get() - shadeBottomY.get()));
	const topHeight = useTransform(() => Math.max(0, y.get() + 1));
	const leftWidth = useTransform(() => Math.max(0, x.get() + 1));
	const cornerRight = useTransform(() => right.get() - radius.get());
	const cornerBottom = useTransform(() => bottom.get() - radius.get());
	const radiusInside = useTransform(radius, value => Math.max(0, value - 1));
	const topLeft = useMotionTemplate`radial-gradient(circle ${radius}px at bottom right, transparent ${radiusInside}px, #000 ${radius}px)`;
	const topRight = useMotionTemplate`radial-gradient(circle ${radius}px at bottom left, transparent ${radiusInside}px, #000 ${radius}px)`;
	const bottomLeft = useMotionTemplate`radial-gradient(circle ${radius}px at top right, transparent ${radiusInside}px, #000 ${radius}px)`;
	const bottomRight = useMotionTemplate`radial-gradient(circle ${radius}px at top left, transparent ${radiusInside}px, #000 ${radius}px)`;

	return <>
		<div className="first-run-mask-layer" aria-hidden="true">
			<motion.div className="first-run-shade" style={{ scaleX: viewportWidth, scaleY: topHeight }} />
			<motion.div className="first-run-shade" style={{ y: shadeBandY, scaleX: leftWidth, scaleY: shadeBandHeight }} />
			<motion.div className="first-run-shade" style={{ x: shadeRightX, y: shadeBandY, scaleX: rightWidth, scaleY: shadeBandHeight }} />
			<motion.div className="first-run-shade" style={{ y: shadeBottomY, scaleX: viewportWidth, scaleY: bottomHeight }} />
			<motion.div className="first-run-corner" style={{ x, y, width: radius, height: radius, background: topLeft }} />
			<motion.div className="first-run-corner" style={{ x: cornerRight, y, width: radius, height: radius, background: topRight }} />
			<motion.div className="first-run-corner" style={{ x, y: cornerBottom, width: radius, height: radius, background: bottomLeft }} />
			<motion.div className="first-run-corner" style={{ x: cornerRight, y: cornerBottom, width: radius, height: radius, background: bottomRight }} />
		</div>
		<motion.div className="first-run-focus" style={{ x, y, left: 0, top: 0, width, height, borderRadius: radius }} aria-hidden="true" />
	</>;
}

function isDesktop(): boolean {
	return typeof window !== 'undefined' && Boolean((window as { cocodeWindow?: unknown }).cocodeWindow);
}

function initialStep(): number {
	try {
		const value = Number(localStorage.getItem(FIRST_RUN_STEP_KEY));
		// 模型弹层不会跨重启保留；从入口重新开始这一段。
		return Number.isInteger(value) && value > 0 && value < TARGETS.length && value !== 1 ? value : 0;
	} catch { return 0; }
}

function initialActive(): boolean {
	if (!isDesktop()) return false;
	try { return localStorage.getItem(FIRST_RUN_TOUR_KEY) !== '1'; }
	catch { return true; }
}

/** 挂在 AppLayout：登录门槛放行后才有真实控件可点击。 */
export function FirstRunTour() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const location = useLocation();
	const reducedMotion = useReducedMotion();
	const [active, setActive] = useState(initialActive);
	const [finished, setFinished] = useState(false);
	const [step, setStep] = useState(initialStep);
	const [paused, setPaused] = useState<PauseReason>(null);
	const [rect, setRect] = useState<Rect | null>(null);
	const [coachPoint, setCoachPoint] = useState<Point>({ left: 24, top: 100 });
	const [viewport, setViewport] = useState({ width: 0, height: 0 });
	const coachRef = useRef<HTMLElement>(null);
	const clickedMenuRef = useRef(false);

	const target = useCallback(() => document.querySelector<HTMLElement>(TARGETS[step]), [step]);
	const advance = useCallback((next: number) => {
		clickedMenuRef.current = false;
		setPaused(null);
		setStep(Math.min(next, TARGETS.length - 1));
	}, []);

	const finishTour = useCallback(() => {
		try {
			localStorage.setItem(FIRST_RUN_TOUR_KEY, '1');
			localStorage.removeItem(FIRST_RUN_STEP_KEY);
		} catch { /* 无存储也允许完成本次引导。 */ }
		setPaused(null);
		setFinished(true);
		window.dispatchEvent(new Event(FIRST_RUN_CLOSE_MODEL_EVENT));
		window.dispatchEvent(new Event(FIRST_RUN_CLOSE_FOLDER_EVENT));
		window.dispatchEvent(new Event(FIRST_RUN_CLOSE_PERMISSION_EVENT));
	}, []);

	useEffect(() => {
		if (!active || finished) return;
		try { localStorage.setItem(FIRST_RUN_STEP_KEY, String(step)); }
		catch { /* 不中断教学。 */ }
	}, [active, finished, step]);

	useEffect(() => {
		if (!active || finished || step === 4) return;
		const focused = document.activeElement;
		if (focused instanceof HTMLTextAreaElement && focused.id === 'tour-chat-textarea') focused.blur();
	}, [active, finished, step]);

	useEffect(() => {
		if (active && !finished && !paused && step < 8 && !location.pathname.startsWith('/chat')) navigate('/chat', { replace: true });
	}, [active, finished, paused, step, location.pathname, navigate]);

	useEffect(() => {
		if (!active || finished || paused) return;
		let animationFrame = 0;
		const measure = () => {
			cancelAnimationFrame(animationFrame);
			animationFrame = requestAnimationFrame(() => {
				const element = target();
				const bounds = element?.getBoundingClientRect();
				setViewport((old) => old.width === window.innerWidth && old.height === window.innerHeight
					? old : { width: window.innerWidth, height: window.innerHeight });
				if (!bounds || bounds.width < 1 || bounds.height < 1) { setRect(null); return; }
				// 贴合目标的真实边框，避免固定的大外扩让小按钮看起来高亮偏移。
				const padding = 3;
				const targetRadius = Number.parseFloat(window.getComputedStyle(element!).borderTopLeftRadius) || 0;
				const next = {
					left: bounds.left - padding,
					top: bounds.top - padding,
					width: bounds.width + padding * 2,
					height: bounds.height + padding * 2,
					radius: Math.max(12, Math.min(18, targetRadius + padding)),
				};
				setRect((old) => old && Object.keys(next).every((key) => old[key as keyof Rect] === next[key as keyof Rect]) ? old : next);
			});
		};
		measure();
		const observer = new MutationObserver(measure);
		observer.observe(document.body, { childList: true, subtree: true });
		window.addEventListener('resize', measure);
		window.addEventListener('scroll', measure, true);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', measure);
			window.removeEventListener('scroll', measure, true);
			cancelAnimationFrame(animationFrame);
		};
	}, [active, finished, paused, step, target, location.pathname]);

	useLayoutEffect(() => {
		if (!rect || !coachRef.current || paused || finished) return;
		const width = window.innerWidth;
		const height = window.innerHeight;
		const coachWidth = coachRef.current.offsetWidth;
		const coachHeight = coachRef.current.offsetHeight;
		if (width < 600) {
			setCoachPoint({ left: 12, top: rect.top > height * .55 ? 12 : Math.max(12, height - coachHeight - 12) });
			return;
		}
		const right = rect.left + rect.width + 18;
		const left = rect.left - coachWidth - 18;
		let x: number;
		let y: number;
		if (right + coachWidth < width - 12) {
			x = right;
			y = rect.top + rect.height / 2 - coachHeight / 2;
		} else if (left > 12) {
			x = left;
			y = rect.top + rect.height / 2 - coachHeight / 2;
		} else {
			x = rect.left + (rect.width - coachWidth) / 2;
			y = rect.top - coachHeight - 18 > 12 ? rect.top - coachHeight - 18 : rect.top + rect.height + 18;
		}
		setCoachPoint({ left: Math.max(12, Math.min(x, width - coachWidth - 12)), top: Math.max(12, Math.min(y, height - coachHeight - 12)) });
	}, [rect, step, paused, finished, t]);

	useEffect(() => {
		if (!active || finished) return;
		const onClick = (event: MouseEvent) => {
			if (paused) return;
			const element = target();
			if (!element || !(event.target instanceof Node) || !element.contains(event.target)) return;
			if (step === 0) window.setTimeout(() => advance(1), 0);
			else if (step === 1) setPaused('settings');
			else if (step === 4) advance(5);
			else if (step === 5) { event.preventDefault(); event.stopPropagation(); advance(6); }
			else if (step === 8 || step === 9) window.setTimeout(() => advance(step + 1), 0);
			else if (step === 10) window.setTimeout(finishTour, 0);
		};
		document.addEventListener('click', onClick, true);
		return () => document.removeEventListener('click', onClick, true);
	}, [active, finished, paused, step, target, advance, finishTour]);

	useEffect(() => {
		if (!active || finished) return;
		const onSettingsClosed = () => { if (paused === 'settings') advance(2); };
		const onFolderOpened = () => { if (step === 2) { clickedMenuRef.current = true; setPaused('folder'); } };
		const onPermissionOpened = () => { if (step === 3) { clickedMenuRef.current = true; setPaused('permission'); } };
		const onFolderClosed = () => { if (step === 2 && clickedMenuRef.current) advance(3); };
		const onPermissionClosed = () => { if (step === 3 && clickedMenuRef.current) advance(4); };
		window.addEventListener(FIRST_RUN_SETTINGS_CLOSED_EVENT, onSettingsClosed);
		window.addEventListener(FIRST_RUN_FOLDER_OPENED_EVENT, onFolderOpened);
		window.addEventListener(FIRST_RUN_FOLDER_CLOSED_EVENT, onFolderClosed);
		window.addEventListener(FIRST_RUN_PERMISSION_OPENED_EVENT, onPermissionOpened);
		window.addEventListener(FIRST_RUN_PERMISSION_CLOSED_EVENT, onPermissionClosed);
		return () => {
			window.removeEventListener(FIRST_RUN_SETTINGS_CLOSED_EVENT, onSettingsClosed);
			window.removeEventListener(FIRST_RUN_FOLDER_OPENED_EVENT, onFolderOpened);
			window.removeEventListener(FIRST_RUN_FOLDER_CLOSED_EVENT, onFolderClosed);
			window.removeEventListener(FIRST_RUN_PERMISSION_OPENED_EVENT, onPermissionOpened);
			window.removeEventListener(FIRST_RUN_PERMISSION_CLOSED_EVENT, onPermissionClosed);
		};
	}, [active, finished, paused, step, advance]);

	if (!active) return null;
	const closeFinish = () => { setActive(false); navigate('/chat'); };
	const skipCurrent = () => {
		if (paused === 'settings') window.dispatchEvent(new Event(FIRST_RUN_CLOSE_SETTINGS_EVENT));
		if (paused === 'folder') window.dispatchEvent(new Event(FIRST_RUN_CLOSE_FOLDER_EVENT));
		if (paused === 'permission') window.dispatchEvent(new Event(FIRST_RUN_CLOSE_PERMISSION_EVENT));
		if (step === 1) window.dispatchEvent(new Event(FIRST_RUN_CLOSE_MODEL_EVENT));
		advance(step + 1);
	};
	const pauseText = paused === 'settings' ? t('firstRun.tour.pauseSettings')
		: paused === 'folder' ? t('firstRun.tour.pauseFolder') : t('firstRun.tour.pausePermission');
	const stepTitle = t(`firstRun.tour.steps.${step}.title`);
	const stepBody = t(`firstRun.tour.steps.${step}.body`);
	const stepChapter = t(`firstRun.tour.steps.${step}.chapter`);
	const showTour = !finished && !paused;
	const shades = rect && showTour ? [
		{ left: 0, top: 0, width: viewport.width, height: rect.top },
		{ left: 0, top: rect.top, width: rect.left, height: rect.height },
		{ left: rect.left + rect.width, top: rect.top, width: viewport.width - rect.left - rect.width, height: rect.height },
		{ left: 0, top: rect.top + rect.height, width: viewport.width, height: viewport.height - rect.top - rect.height },
	] : [];

	return createPortal(
		<>
			{showTour && rect ? <SpotlightMask rect={rect} viewport={viewport} reducedMotion={Boolean(reducedMotion)} /> : null}
			{shades.map((shade, index) => <div key={index} className="first-run-blocker" style={{ ...shade, width: Math.max(0, shade.width), height: Math.max(0, shade.height) }} />)}
			{showTour && (step === 6 || step === 7) ? (
				<div className="first-run-demo" aria-label={t('firstRun.tour.demoTag')}>
					<div className="text-xs text-muted-foreground">{t('firstRun.tour.demoTag')}</div>
					<p className="mt-3 text-sm font-medium">{t('firstRun.tour.demoMessage')}</p>
					<p className="mt-2 text-sm text-muted-foreground">{t('firstRun.tour.demoResponse')}</p>
					{step === 6 ? <button type="button" id="first-run-demo-approve" onClick={() => advance(7)}><ShieldCheck className="size-4" />{t('firstRun.tour.demoApprove')}</button> : null}
					{step === 7 ? <button type="button" id="first-run-demo-checkpoint" onClick={() => advance(8)}><History className="size-4" />{t('firstRun.tour.demoCheckpoint')}</button> : null}
				</div>
			) : null}
			{showTour ? (
				<section ref={coachRef} className="first-run-coach" style={{ left: coachPoint.left, top: coachPoint.top }} aria-live="polite" aria-label={stepTitle}>
					<div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>{stepChapter}</span><span className="tabular-nums">{String(step + 1).padStart(2, '0')} / {TARGETS.length}</span></div>
					<div className="mt-3 h-0.5 bg-muted"><div className="h-full bg-foreground transition-[width] duration-300" style={{ width: `${((step + 1) / TARGETS.length) * 100}%` }} /></div>
					<h2 className="mt-4 text-lg font-medium">{rect ? stepTitle : t('firstRun.tour.loading')}</h2>
					<p className="mt-2 text-sm leading-6 text-muted-foreground">{stepBody}</p>
					{step === 5 ? <button type="button" className="first-run-primary" onClick={() => advance(6)}>{t('firstRun.tour.demoSend')}</button> : null}
					<div className="mt-5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
						<span className="flex items-center gap-1"><MousePointer2 className="size-3.5" />{step === 5 ? t('firstRun.tour.demoTag') : t('firstRun.tour.clickHint')}</span>
						<div className="flex shrink-0 gap-2">{[1, 2, 3].includes(step) ? <button type="button" onClick={skipCurrent}>{t('firstRun.tour.later')}</button> : null}<button type="button" onClick={finishTour}>{t('firstRun.tour.skip')}</button></div>
					</div>
				</section>
			) : null}
			{paused ? <div className="first-run-paused" role="status"><span>{pauseText}</span><button type="button" onClick={skipCurrent}>{t('firstRun.tour.later')}</button></div> : null}
			{finished ? <div className="first-run-finish-backdrop" role="dialog" aria-modal="true" aria-labelledby="first-run-complete-title"><div className="first-run-finish"><div className="first-run-finish-mark">✓</div><h2 id="first-run-complete-title" className="mt-4 text-xl font-medium">{t('firstRun.tour.completeTitle')}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{t('firstRun.tour.completeBody')}</p><div className="mt-6 flex justify-center gap-2"><button type="button" className="first-run-primary" onClick={closeFinish}>{t('firstRun.tour.startWorking')}</button><button type="button" className="first-run-secondary" onClick={() => { try { localStorage.removeItem(FIRST_RUN_TOUR_KEY); } catch { /* 当前会话仍可重播。 */ } setFinished(false); setStep(0); navigate('/chat'); }}>{t('firstRun.tour.startAgain')} <RotateCcw className="size-3.5" /></button></div></div></div> : null}
		</>, document.body,
	);
}
