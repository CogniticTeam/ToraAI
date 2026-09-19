// Applied before the first paint, so the theme never flashes.
// Respects an explicit user choice stored at `cocode.theme`
// by useTheme(); falls back to OS preference otherwise.
// 另承担「加载页」职责：原生窗口背景由主进程按主题着色，这里在
// 任何 CSS/React 就绪之前 (1) 给 <html> 写死同款底色兜底 CSS 加载窗口期，
// (2) 通过 cocodeWindow.reportTheme 把实际深浅上报主进程纠正窗口背景
// （preload 先于页面脚本执行，桥此时必然就位）。
//
// 注意：本文件必须保持为「外部脚本」经 <script src> 引入——主进程在
// session 层注入的 CSP 为 script-src 'self'，内联脚本会被静默拦截
// （pre-paint 不执行 → 深色模式下加载页闪白）。
const KEY = 'cocode.theme';
const stored = (() => {
	try { return localStorage.getItem(KEY); } catch { return null; }
})();
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
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
	window.cocodeWindow?.reportTheme?.(useDark);
};
applyTheme();
darkQuery.addEventListener('change', applyTheme);
