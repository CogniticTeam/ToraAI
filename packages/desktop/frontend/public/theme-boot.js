// Applied before the first paint, so the theme never flashes.
// Respects an explicit user choice stored at `tora.theme`
// by useTheme(); falls back to OS preference otherwise.
// 另承担「加载页」职责：原生窗口背景由主进程按主题着色，这里在
// 任何 CSS/React 就绪之前 (1) 给 <html> 写死同款底色兜底 CSS 加载窗口期，
// (2) 通过 toraWindow.reportTheme 把实际深浅上报主进程纠正窗口背景
// （preload 先于页面脚本执行，桥此时必然就位）。
//
// 注意：本文件必须保持为「外部脚本」经 <script src> 引入——主进程在
// session 层注入的 CSP 为 script-src 'self'，内联脚本会被静默拦截
// （pre-paint 不执行 → 深色模式下加载页闪白）。
const KEY = 'tora.theme';
const BACKGROUND_KEY = 'tora.background';
const CUSTOM_BACKGROUND_KEY = 'tora.background.custom';
const BACKGROUND_CHANGED_EVENT = 'tora:background-changed';
const MOTION_MODE_KEY = 'tora.motion.mode';
const MOTION_CLICK_KEY = 'tora.motion.click';
const MOTION_PAGE_KEY = 'tora.motion.page';
const MOTION_CHANGED_EVENT = 'tora:motion-changed';
const BACKGROUND_OPTIONS = new Set(['lavender', 'mist', 'stone', 'midnight', 'none', 'custom']);
const readStored = (key) => {
	try { return localStorage.getItem(key); } catch { return null; }
};
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const applyTheme = () => {
	const stored = readStored(KEY);
	let useDark;
	if (stored === 'dark') useDark = true;
	else if (stored === 'light') useDark = false;
	else useDark = darkQuery.matches;
	document.documentElement.classList.toggle('dark', useDark);
	// CSS 文件加载前的底色兜底（值与 index.css 的 --bg 一致）。
	document.documentElement.style.background = useDark ? '#0c0d10' : '#f4f5f6';
	// CSS 就位前让原生控件/滚动条也走对应配色。
	document.documentElement.style.colorScheme = useDark ? 'dark' : 'light';
	// 纠正主进程建窗时的猜测（跟系统），并让主进程记住本次主题。
	window.toraWindow?.reportTheme?.(useDark);
};
const applyBackground = () => {
	const root = document.documentElement;
	const saved = readStored(BACKGROUND_KEY);
	const custom = readStored(CUSTOM_BACKGROUND_KEY);
	const safeCustom = custom && custom.length <= 2500000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(custom);
	const choice = BACKGROUND_OPTIONS.has(saved) ? saved : 'lavender';
	root.dataset.appBackground = choice === 'custom' && !safeCustom ? 'none' : choice;
	if (choice === 'custom' && safeCustom) root.style.setProperty('--app-custom-wallpaper', `url("${custom}")`);
	else root.style.removeProperty('--app-custom-wallpaper');
};
const applyMotion = () => {
	const saved = readStored(MOTION_MODE_KEY);
	const mode = ['off', 'gentle', 'standard', 'fast'].includes(saved) ? saved : 'system';
	const effective = reducedMotionQuery.matches || mode === 'off' ? 'off' : mode === 'system' ? 'standard' : mode;
	const clickEnabled = effective !== 'off' && readStored(MOTION_CLICK_KEY) !== '0';
	const pageEnabled = effective !== 'off' && readStored(MOTION_PAGE_KEY) !== '0';
	const profiles = {
		off: { duration: '0ms', scale: '1' },
		gentle: { duration: '190ms', scale: '0.985' },
		standard: { duration: '140ms', scale: '0.975' },
		fast: { duration: '85ms', scale: '0.985' },
	};
	const root = document.documentElement;
	root.dataset.motion = effective;
	root.dataset.motionClick = clickEnabled ? 'on' : 'off';
	root.dataset.motionPage = pageEnabled ? 'on' : 'off';
	root.style.setProperty('--tora-click-duration', profiles[effective].duration);
	root.style.setProperty('--tora-press-scale', profiles[effective].scale);
};
applyTheme();
applyBackground();
applyMotion();
darkQuery.addEventListener('change', applyTheme);
reducedMotionQuery.addEventListener('change', applyMotion);
window.addEventListener(BACKGROUND_CHANGED_EVENT, applyBackground);
window.addEventListener(MOTION_CHANGED_EVENT, applyMotion);
window.addEventListener('storage', (event) => {
	if (event.key === KEY) applyTheme();
	if (event.key === BACKGROUND_KEY || event.key === CUSTOM_BACKGROUND_KEY) applyBackground();
	if ([MOTION_MODE_KEY, MOTION_CLICK_KEY, MOTION_PAGE_KEY].includes(event.key)) applyMotion();
});
