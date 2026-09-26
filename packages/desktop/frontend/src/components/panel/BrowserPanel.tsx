// 内置浏览器面板。
//
// 「浏览器表面」有两种实现，走同一个适配器接口：
//   · Electron 桌面端：<webview> —— 真浏览器（独立进程、能登录、能跑 JS）
//   · 纯浏览器/开发环境：<iframe> —— 同源页面完全可用；跨源站点大多会被
//     X-Frame-Options / CSP 拒绝嵌入，或者读不到内容。这种情况会**明确报错**，
//     而不是返回一份空内容假装成功。
//
// 面板同时把 Agent 的入口暴露成一个全局桥 `window.__cocodeBrowser`：桌面端主进程
// 通过 executeJavaScript 调进来，把 Browser 工具的动作落到这个页面上。桥只在面板
// 挂载期间存在 —— 主进程找不到它时会先派发 cocode:open-panel 把面板打开再重试。
//
// 多标签页：每个标签页一个常驻 webview/iframe，由模块级标签管理器统一持有；
// 页面动作默认作用于活动标签（params.tab 可指定），另有 tabs / new_tab /
// switch_tab / close_tab 四个管理动作。

import { ArrowLeft, ArrowRight, ExternalLink, Globe, LoaderCircle, Plus, RotateCw, SquareDashedMousePointer, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useI18n';
import { insertElementRef } from '@/lib/insertChatText';
import { getSearchEngineHomeUrl, normalizeUrl, resolveAddressInput } from '@/lib/searchEngine';
import { cn } from '@/lib/utils';

/** 在页面里"读正文"的脚本。返回 JSON 字符串（跨进程传输更稳）。 */
const READ_SCRIPT = `JSON.stringify({
  title: document.title || '',
  url: location.href,
  text: document.body ? document.body.innerText || '' : ''
})`;

/**
 * 在页面里执行一段脚本的包装。
 *
 * 一律用 IIFE + JSON.stringify：<webview>.executeJavaScript 与 iframe 的
 * contentWindow.eval 对返回值的处理不同（结构化克隆 vs 直接求值），字符串是两边都稳的。
 */
function script(fnBody: string) {
	return `JSON.stringify((() => { ${fnBody} })())`;
}

const PICKER_START_SCRIPT = script(
	`if (window.__cocodePickStop) window.__cocodePickStop();
	 window.__cocodePick = null;
	 window.__cocodePickActive = true;
	 const ov = document.createElement('div');
	 ov.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;border:2px solid #8b5cf6;border-radius:4px;background:rgba(139,92,246,.14);box-shadow:0 0 0 1px rgba(139,92,246,.25),0 4px 14px rgba(139,92,246,.35);';
	 const label = document.createElement('div');
	 label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 11px/1.6 ui-sans-serif,system-ui,sans-serif;padding:1px 6px;border-radius:4px;background:#8b5cf6;color:#fff;';
	 document.documentElement.append(ov, label);
	 const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^a-zA-Z0-9_\\u00A0-\\uFFFF-])/g, '\\\\$1'));
	 const selFor = (el) => {
	   if (el.id) return '#' + cssEscape(el.id);
	   const parts = [];
	   let node = el;
	   while (node && node.nodeType === 1 && parts.length < 6) {
	     const name = node.tagName.toLowerCase();
	     if (name === 'html' || name === 'body') { parts.unshift(name); break; }
	     let part = name;
	     const parent = node.parentElement;
	     if (parent) {
	       const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
	       if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
	     }
	     parts.unshift(part);
	     node = parent;
	   }
	   return parts.join(' > ');
	 };
	 const describe = (t) => ({ selector: selFor(t), tag: t.tagName.toLowerCase(), text: (t.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) });
	 const onMove = (e) => {
	   const t = e.target;
	   const r = t instanceof Element ? t.getBoundingClientRect() : null;
	   if (!r || (!r.width && !r.height) || t === document.documentElement) { ov.style.display = 'none'; label.style.display = 'none'; return; }
	   ov.style.display = 'block'; ov.style.left = r.left + 'px'; ov.style.top = r.top + 'px'; ov.style.width = r.width + 'px'; ov.style.height = r.height + 'px';
	   const d = describe(t); label.textContent = d.tag + (d.text ? ' · ' + d.text : '');
	   label.style.left = Math.max(4, r.left) + 'px'; label.style.top = (r.top - 24 >= 2 ? r.top - 24 : r.bottom + 4) + 'px'; label.style.display = 'block';
	 };
	 const cleanup = () => {
	   ov.remove(); label.remove(); NAMES.forEach((name) => document.removeEventListener(name, onPointer, true));
	   document.removeEventListener('mousemove', onMove, true); document.removeEventListener('keydown', onKey, true);
	   window.__cocodePickStop = null; window.__cocodePickActive = false;
	 };
	 const onPointer = (e) => {
	   e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
	   if (e.type === 'click' && e.target instanceof Element) { window.__cocodePick = describe(e.target); cleanup(); }
	 };
	 const onKey = (e) => {
	   if (e.key !== 'Escape') return;
	   e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); window.__cocodePick = { cancelled: true }; cleanup();
	 };
	 const NAMES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'contextmenu'];
	 NAMES.forEach((name) => document.addEventListener(name, onPointer, true)); document.addEventListener('mousemove', onMove, true); document.addEventListener('keydown', onKey, true);
	 window.__cocodePickStop = cleanup;
	 return { ok: true };`,
);

const PICKER_READ_SCRIPT = script(
	`return { active: !!window.__cocodePickActive, pick: window.__cocodePick || null };`,
);

const PICKER_STOP_SCRIPT = script(
	`if (window.__cocodePickStop) window.__cocodePickStop(); window.__cocodePick = null; return { ok: true };`,
);

const CLICK_SCRIPT = (selector: string) =>
	script(
		`const all = document.querySelectorAll(${JSON.stringify(selector)});
		 const first = all[0];
		 if (first) first.click();
		 return { matched: all.length };`,
	);

const TYPE_SCRIPT = (selector: string, text: string) =>
	script(
		`const all = document.querySelectorAll(${JSON.stringify(selector)});
		 const el = all[0];
		 if (!el) return { matched: 0 };
		 const text = ${JSON.stringify(text)};
		 el.focus();
		 const proto = el instanceof HTMLTextAreaElement
		   ? HTMLTextAreaElement.prototype
		   : HTMLInputElement.prototype;
		 const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
		 let viaEditPipeline = false;
		 // 优先走浏览器的编辑管线：execCommand('insertText') 会产出规范的
		 // beforeinput/input 事件（inputType=insertText），React/Vue 这类受控
		 // 组件都能正确接住。直接改 .value 再手搓事件，框架有时认、有时不认，
		 // 认不出的下一次渲染就会把值刷回去（用户视角：刚输的字自己没了）。
		 try {
		   if (!el.isContentEditable && setter) setter.call(el, '');
		   if (typeof el.select === 'function') el.select();
		   viaEditPipeline = document.execCommand('insertText', false, text);
		 } catch (e) { viaEditPipeline = false; }
		 // 兜底：编辑管线不可用时，退回原生 setter + 显式事件
		 if (!viaEditPipeline || el.value !== text) {
		   if (setter) setter.call(el, text); else el.value = text;
		   el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
		   el.dispatchEvent(new Event('change', { bubbles: true }));
		 }
		 // 回报是否真的写进去了 —— 让"没写进去"变成可见的失败，而不是静默无效
		 return { matched: all.length, applied: el.value === text, method: viaEditPipeline ? 'insertText' : 'setter' };`,
	);

const PRESS_SCRIPT = (key: string) =>
	script(
		`const el = document.activeElement || document.body;
		 const init = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true };
		 el.dispatchEvent(new KeyboardEvent('keydown', init));
		 el.dispatchEvent(new KeyboardEvent('keypress', init));
		 el.dispatchEvent(new KeyboardEvent('keyup', init));
		 return { ok: true };`,
	);

const STATE_SCRIPT = `JSON.stringify({ title: document.title || '', url: location.href })`;

const COUNT_SCRIPT = (selector: string) =>
	script(`return { matched: document.querySelectorAll(${JSON.stringify(selector)}).length };`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 复查输入是否真的留在框里（有些页面会把自己的值刷回来）。 */
const VERIFY_TEXT_SCRIPT = (selector: string, text: string) =>
	script(
		`const el = document.querySelectorAll(${JSON.stringify(selector)})[0];
		 return { matched: el ? 1 : 0, applied: !!el && el.value === ${JSON.stringify(text)} };`,
	);

/**
 * 等元素出现再动手。
 *
 * 为什么必须等：`navigate()` 的"加载完成"只保证 HTML 到了 —— 单页应用的 DOM
 * 要等 JS 跑完才存在，中间可能差几百毫秒到几秒。模型拿到"已打开"后立刻
 * click/type 是很自然的，如果那时元素还没渲染出来就返回"没找到"，它会以为
 * 选择器写错了，然后开始瞎试。等待重试是浏览器自动化的标准做法
 * （Playwright 的 auto-wait 就是干这个），代价只是几轮 IPC。
 *
 * @returns 命中的元素个数；等满 timeout 仍为 0 才返回 0。
 */
async function waitForSelector(s: Surface, selector: string, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const raw = await s.evaluate(COUNT_SCRIPT(selector));
		const n = parseJson<{ matched: number }>(raw)?.matched ?? 0;
		if (n > 0) return n;
		if (Date.now() >= deadline) return 0;
		await sleep(200);
	}
}

/** 单次导航的最长等待。超时不报错 —— 页面可能只是慢，先让用户看到它。 */
const NAV_TIMEOUT_MS = 20000;

type SurfaceKind = 'webview' | 'iframe';

/** 浏览器表面的统一接口：两种实现（webview / iframe）后面对应的操作都在这里收敛。 */
interface Surface {
	kind: SurfaceKind;
	navigate(url: string): Promise<void>;
	back(): void;
	forward(): void;
	reload(): void;
	canGoBack(): boolean;
	canGoForward(): boolean;
	currentUrl(): string;
	title(): string;
	evaluate(code: string): Promise<string>;
	/**
	 * 截取当前画面，返回 `data:image/...` 形式的 data URL。
	 * 只有 webview 表面支持（iframe 读不到跨源页面的像素）—— 不支持时为 undefined，
	 * 上层据此报"桌面端才有"而不是抛一个莫名其妙的内部错误。
	 */
	capture?(): Promise<string>;
	dispose(): void;
}

function isElectron() {
	return /Electron/i.test(navigator.userAgent);
}

/** Electron：真浏览器，能力最全。 */
function createWebviewSurface(el: HTMLElement): Surface {
	// <webview> 是 Electron 的私有自定义元素，TS 里没有类型
	const wv = el as unknown as {
		loadURL(u: string): void | Promise<void>;
		getURL(): string;
		getTitle(): string;
		canGoBack(): boolean;
		canGoForward(): boolean;
		goBack(): void;
		goForward(): void;
		reload(): void;
		executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
		capturePage(): Promise<unknown>;
		addEventListener(t: string, fn: (e: never) => void, o?: AddEventListenerOptions): void;
		removeEventListener(t: string, fn: (e: never) => void, o?: AddEventListenerOptions): void;
	};

	// —— guest 就绪门闩 ——
	//
	// <webview> 的**所有**方法（loadURL/executeJavaScript/getURL/goBack…）内部都先走
	// getWebContentsId()，而 guestInstanceId 只在 createGuest() 的**异步回执**里才有
	// （attachGuestInstance）。guest 只能靠「设置 src 属性」启动：Electron 在
	// connectedCallback 里解析 src → createGuest，guest 带着这个 URL 直接加载。
	//
	// 所以在一个从没设过 src 的空 webview 上调 loadURL，抛的就是那行
	// "The WebView must be attached to the DOM and the dom-ready event emitted
	//  before this method can be called."（web-view-constants 的 NOT_ATTACHED，
	// 条件是 guestInstanceId 还没回执，报错文案只是把两种情形合并着说）。
	//
	// 规则由此而来：
	//   · 从未设过 src：导航必须 setAttribute('src', …) —— 这是启动 guest 的唯一方式；
	//     注意不能用 el.src = url，webview 的 src 不是 DOM 反射属性，只有设 attribute
	//     才会被 SrcAttribute 的 MutationObserver 观察到。
	//   · src 已设、guest 还在创建：先等就绪再 loadURL（避免撞上同一行报错）。
	//   · 就绪信号：dom-ready 或 did-stop-loading 任一（都意味着 guest 已存在）。
	let srcSet = false;
	let guestReady = false;
	// guest 就绪前 getURL() 会抛错，用最后一次导航的目标地址兜底 ——
	// 否则新建标签页导航后，地址栏会被尚未就绪的空 url 同步掉。
	let lastUrl = '';
	const readyWaiters: Array<() => void> = [];
	const markReady = () => {
		if (guestReady) return;
		guestReady = true;
		while (readyWaiters.length) readyWaiters.shift()!();
	};
	el.addEventListener('dom-ready', markReady);
	el.addEventListener('did-stop-loading', markReady);

	const whenReady = (timeoutMs: number): Promise<void> => {
		if (guestReady) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				const i = readyWaiters.indexOf(done);
				if (i >= 0) readyWaiters.splice(i, 1);
				reject(new Error('内置浏览器一直没就绪（页面迟迟没有发出 dom-ready）'));
			}, timeoutMs);
			readyWaiters.push(done);
		});
	};

	const NOT_OPENED =
		'还没有打开任何页面。请先 open 一个网址（在地址栏输入回车，或让 Agent 调 open 动作）。';

	const safe = <T,>(fn: () => T, fallback: T): T => {
		try {
			return fn();
		} catch {
			return fallback;
		}
	};
	/** 没加载过任何页面就调导航类动作，给一句人话，而不是 Electron 的内部报错。 */
	const requireOpened = (fn: () => void, label: string) => {
		if (!srcSet) throw new Error(NOT_OPENED);
		try {
			fn();
		} catch (e) {
			throw new Error(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	return {
		kind: 'webview',
		navigate(url) {
			return new Promise<void>((resolve, reject) => {
				let settled = false;
				const timer = setTimeout(() => finish(), NAV_TIMEOUT_MS);
				const finish = (err?: Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					wv.removeEventListener('did-stop-loading', onStop);
					wv.removeEventListener('did-fail-load', onFail);
					err ? reject(err) : resolve();
				};
				const onStop = () => finish();
				const onFail = (e: { errorDescription?: string }) => {
					// -3 是 ABORTED：通常是页面内部重定向，不是真失败
					if (e?.errorDescription && !/ERR_ABORTED/.test(e.errorDescription)) {
						finish(new Error(e.errorDescription));
						return;
					}
					finish();
				};
				wv.addEventListener('did-stop-loading', onStop);
				wv.addEventListener('did-fail-load', onFail as never);
				const start = async () => {
					try {
						lastUrl = url;
						if (!srcSet) {
							// 首次导航：设 src 属性启动 guest（loadURL 此刻必抛 NOT_ATTACHED）
							srcSet = true;
							el.setAttribute('src', url);
						} else {
							await whenReady(NAV_TIMEOUT_MS - 1000);
							void wv.loadURL(url);
						}
					} catch (e) {
						finish(e instanceof Error ? e : new Error(String(e)));
					}
				};
				void start();
			});
		},
		back: () => requireOpened(() => wv.goBack(), '后退'),
		forward: () => requireOpened(() => wv.goForward(), '前进'),
		reload: () => requireOpened(() => wv.reload(), '刷新'),
		canGoBack: () => safe(() => wv.canGoBack(), false),
		canGoForward: () => safe(() => wv.canGoForward(), false),
		currentUrl: () => safe(() => wv.getURL(), '') || lastUrl,
		title: () => safe(() => wv.getTitle(), ''),
		async evaluate(code) {
			if (!srcSet) throw new Error(NOT_OPENED);
			// guest 创建是异步的；极端情况下 load 已停但方法仍可能撞上未回执的窗口
			await whenReady(NAV_TIMEOUT_MS - 1000);
			const out = await wv.executeJavaScript(code, true);
			return typeof out === 'string' ? out : JSON.stringify(out ?? null);
		},
		async capture() {
			if (!srcSet) throw new Error(NOT_OPENED);
			await whenReady(NAV_TIMEOUT_MS - 1000);
			// capturePage 在 Electron 的 webview 异步方法表里（v33 已确认），返回
			// NativeImage。但这个值要跨一层内部 IPC 反序列化，万一哪天行为变了
			// 变成普通对象/字符串，这里必须兜住 —— 不能把空数据当截图成功。
			const img = await wv.capturePage();
			let dataUrl = '';
			try {
				const anyImg = img as { toDataURL?: () => string; toPNG?: () => Uint8Array };
				if (typeof anyImg?.toDataURL === 'function') dataUrl = anyImg.toDataURL();
				else if (typeof anyImg?.toPNG === 'function') {
					let bin = '';
					for (const b of anyImg.toPNG()) bin += String.fromCharCode(b);
					dataUrl = `data:image/png;base64,${btoa(bin)}`;
				} else if (typeof img === 'string') dataUrl = img;
			} catch {
				dataUrl = '';
			}
			if (!dataUrl.startsWith('data:image/')) {
				throw new Error('页面还没渲染出可截取的内容，或当前 Electron 版本不支持在 webview 上截图');
			}
			return dataUrl;
		},
		dispose() {}
	};
}

/**
 * 纯浏览器/开发环境：<iframe>。
 *
 * 能力有限且**限制是浏览器的，不是我们的** —— 跨源页面读不到内容（同源策略），
 * 很多站点还会用 X-Frame-Options 直接拒绝被嵌入。所以这里读不到就抛错，
 * 让上层如实告诉用户"用桌面端"，而不是返回空字符串冒充成功。
 */
function createIframeSurface(el: HTMLIFrameElement): Surface {
	// iframe 没有原生历史 API 可用，自己记一个栈
	const stack: string[] = [];
	let cursor = -1;
	const pushUrl = (u: string) => {
		if (cursor >= 0 && stack[cursor] === u) return;
		stack.splice(cursor + 1);
		stack.push(u);
		cursor = stack.length - 1;
	};
	return {
		kind: 'iframe',
		navigate(url) {
			pushUrl(url);
			return new Promise<void>((resolve) => {
				const timer = setTimeout(finish, NAV_TIMEOUT_MS);
				function finish() {
					clearTimeout(timer);
					el.removeEventListener('load', finish);
					resolve();
				}
				el.addEventListener('load', finish);
				el.src = url;
			});
		},
		back() {
			if (cursor > 0) {
				cursor -= 1;
				el.src = stack[cursor];
			}
		},
		forward() {
			if (cursor < stack.length - 1) {
				cursor += 1;
				el.src = stack[cursor];
			}
		},
		reload: () => {
			// eslint-disable-next-line no-self-assign
			el.src = el.src;
		},
		canGoBack: () => cursor > 0,
		canGoForward: () => cursor < stack.length - 1,
		currentUrl: () => {
			try {
				return el.contentWindow?.location.href || el.src;
			} catch {
				return el.src;
			}
		},
		title: () => {
			try {
				return el.contentDocument?.title || '';
			} catch {
				return '';
			}
		},
		async evaluate(code) {
			const w = el.contentWindow;
			if (!w) throw new Error('页面还没就绪');
			try {
				// TS 的 DOM 类型没给 Window 声明 eval，这里显式转一下
				const run = w as unknown as { eval: (c: string) => unknown };
				const out = run.eval(code);
				return typeof out === 'string' ? out : JSON.stringify(out ?? null);
			} catch (e) {
				throw new Error(
					`读不到这个页面的内容（跨源页面会被浏览器的同源策略挡住）：${
						e instanceof Error ? e.message : String(e)
					}。桌面端的内置浏览器没有这个限制。`,
				);
			}
		},
		dispose() {}
	};
}

function parseJson<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** 地址栏未编辑时的紧凑展示：host + 路径，省掉协议和根斜杠（https://baidu.com/ → baidu.com）。 */
function prettyUrl(raw: string): string {
	if (!raw) return '';
	try {
		const u = new URL(raw);
		const rest = u.pathname === '/' ? `${u.hash}` : `${u.pathname}${u.search}${u.hash}`;
		return `${u.host}${rest}`;
	} catch {
		return raw;
	}
}

// —— 模块级常驻标签页管理 ——
//
// <webview> 有个硬约束：一旦被移出 DOM，Electron 的 disconnectedCallback 会
// detachGuest **直接销毁 guest**（页面、登录态、滚动位置全丢）。所以"把实例
// 存起来等下次再挂回去"行不通 —— 唯一可行的常驻方式是让 webview 元素终生
// 留在文档里。多标签页的做法：每个标签页一个 webview，全部挂在 body 下的
// 同一个模块级宿主里，永不挪窝；非活动标签用 display:none 隐藏（仍在文档内，
// guest 不销毁）。面板只负责两件事 —— 打开时把宿主逐帧对齐到自己的占位区，
// 关闭时把宿主藏到屏外。页面状态因此能活过 面板开关 / 聊天页切换 / 标签切换。
// 只有显式关闭标签页才会把元素摘出文档 —— 那是页面真正死亡的唯一时刻。

interface BrowserTab {
	id: number;
	el: HTMLElement;
	surface: Surface;
	loading: boolean;
}

let persistentHost: HTMLElement | null = null;
const tabs: BrowserTab[] = [];
let activeTabId: number | null = null;
let nextTabId = 1;
let tabsVersion = 0;
const tabListeners = new Set<() => void>();

function notifyTabs() {
	tabsVersion += 1;
	tabListeners.forEach((fn) => fn());
}

function subscribeTabs(fn: () => void) {
	tabListeners.add(fn);
	return () => {
		tabListeners.delete(fn);
	};
}

function ensurePersistentHost(): HTMLElement {
	if (!persistentHost) {
		persistentHost = document.createElement('div');
		persistentHost.dataset.browserHost = 'true';
		// z-index 5：要盖住面板占位区，但必须低于一切 popover/对话框（z-50）。
		// 不能用大数值压顶 —— 那会把下拉、浮层全部盖住（本项目 CSS 分层纪律）。
		persistentHost.style.cssText =
			'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;' +
			'visibility:hidden;pointer-events:none;z-index:5;border-radius:6px;';
		document.body.appendChild(persistentHost);
	}
	return persistentHost;
}

function applyTabVisibility() {
	for (const t of tabs) t.el.style.display = t.id === activeTabId ? '' : 'none';
}

function getActiveTab(): BrowserTab | null {
	return tabs.find((t) => t.id === activeTabId) ?? null;
}

function getTabById(id: number): BrowserTab | null {
	return tabs.find((t) => t.id === id) ?? null;
}

/** 新建标签页。activate=false 时静默追加（供主进程后台开页之类场景用）。 */
function createTab(kind: SurfaceKind, activate = true): BrowserTab {
	const host = ensurePersistentHost();
	const tab: BrowserTab = {
		id: nextTabId++,
		el: null as unknown as HTMLElement,
		surface: null as unknown as Surface,
		loading: false,
	};
	if (kind === 'webview') {
		const el = document.createElement('webview') as unknown as HTMLElement;
		// 必须开 allowpopups：否则 target="_blank" / window.open() 这类跳转会在
		// guest 渲染层被 Chromium 直接拦掉，主进程的 setWindowOpenHandler 根本
		// 收不到请求。开了之后请求到达主进程，统一 deny 并转成 browser:popup 事件
		// 回传渲染层，由下方订阅开成新的内置浏览器标签页（见 cocodeBrowserHost）。
		el.setAttribute('allowpopups', '');
		el.className = 'h-full w-full';
		tab.el = el;
		tab.surface = createWebviewSurface(el);
		el.addEventListener('did-start-loading', () => {
			tab.loading = true;
			notifyTabs();
		});
		el.addEventListener('did-stop-loading', () => {
			tab.loading = false;
			notifyTabs();
		});
		el.addEventListener('page-title-updated', () => notifyTabs());
		el.addEventListener('did-navigate', () => notifyTabs());
		el.addEventListener('did-navigate-in-page', () => notifyTabs());
	} else {
		const el = document.createElement('iframe');
		el.className = 'h-full w-full border-0 bg-background';
		// 尽量放开 iframe 的能力；被站点拒绝是它的自由，上层如实报错
		el.setAttribute('referrerpolicy', 'no-referrer');
		tab.el = el;
		tab.surface = createIframeSurface(el);
		el.addEventListener('load', () => {
			tab.loading = false;
			notifyTabs();
		});
	}
	tab.el.style.display = 'none';
	host.appendChild(tab.el);
	tabs.push(tab);
	if (activate) setActiveTab(tab.id);
	else notifyTabs();
	return tab;
}

function setActiveTab(id: number | null) {
	activeTabId = id;
	applyTabVisibility();
	notifyTabs();
}

function closeTab(id: number) {
	const idx = tabs.findIndex((t) => t.id === id);
	if (idx < 0) return;
	const [gone] = tabs.splice(idx, 1);
	// 全文件唯一一处刻意销毁 guest 的地方：把元素摘出文档。
	gone.el.remove();
	if (activeTabId === id) {
		const next = tabs[Math.min(idx, tabs.length - 1)] ?? null;
		activeTabId = next?.id ?? null;
	}
	applyTabVisibility();
	notifyTabs();
}

interface TabInfo {
	id: number;
	title: string;
	url: string;
	loading: boolean;
	active: boolean;
}

function listTabs(): TabInfo[] {
	return tabs.map((t) => ({
		id: t.id,
		title: t.surface.title(),
		url: t.surface.currentUrl(),
		loading: t.loading,
		active: t.id === activeTabId,
	}));
}

// —— guest 弹窗 → 新标签页 ——
// 页面里 target="_blank" / window.open() 的跳转请求，经主进程 setWindowOpenHandler
// 拦截（allowpopups 保证请求能到达）后，以 browser:popup 事件转回渲染层。
// 放在模块级而非组件里：本模块只会被 import 执行一次，不会重复订阅。
type BrowserHostBridge = { onPopup: (cb: (url: string) => void) => void };
const browserHost = (window as unknown as { cocodeBrowserHost?: BrowserHostBridge }).cocodeBrowserHost;
browserHost?.onPopup((url) => {
	const tab = createTab('webview');
	void tab.surface.navigate(url).catch(() => {
		// 与桥里 new_tab 同样的回滚：开页失败就摘掉这个半成品标签，别留空壳
		closeTab(tab.id);
	});
});

interface BrowserPanelProps {
	/** 挂载时没有任何标签页则自动导航到该地址（全屏入口的开始页；dock 面板不传则保持空态）。 */
	initialUrl?: string;
	/** 是否提供将网页元素附加到聊天输入框的选取工具。 */
	enableElementPicker?: boolean;
}

export function BrowserPanel({ initialUrl, enableElementPicker = true }: BrowserPanelProps) {
	const { t } = useTranslation();
	const pageRef = useRef<HTMLDivElement | null>(null);
	const [draft, setDraft] = useState('');
	const [editing, setEditing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const kind = useMemo(() => (isElectron() ? 'webview' : 'iframe'), []);
	// 标签页管理器的任何变化都会 bump version，组件据此重读最新快照。
	const version = useSyncExternalStore(
		subscribeTabs,
		() => tabsVersion,
		() => tabsVersion,
	);
	void version;
	const infos = listTabs();
	const active = infos.find((t) => t.active) ?? null;
	const activeTab = getActiveTab();
	const current = active?.url ?? '';
	const title = active?.title ?? '';
	const loading = activeTab?.loading ?? false;
	const nav = activeTab
		? { back: activeTab.surface.canGoBack(), forward: activeTab.surface.canGoForward() }
		: { back: false, forward: false };

	const [picking, setPicking] = useState(false);
	const pickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
	const pickTabRef = useRef<BrowserTab | null>(null);

	const stopPicking = useCallback(() => {
		if (pickTimer.current) {
			clearInterval(pickTimer.current);
			pickTimer.current = null;
		}
		const tab = pickTabRef.current;
		pickTabRef.current = null;
		setPicking(false);
		tab?.surface.evaluate(PICKER_STOP_SCRIPT).catch(() => undefined);
	}, []);

	const startPicking = async () => {
		if (!enableElementPicker) return;
		const tab = getActiveTab();
		if (!tab) {
			setError(t('browserPanel.noTabPick'));
			return;
		}
		setError(null);
		try {
			await tab.surface.evaluate(PICKER_START_SCRIPT);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return;
		}
		pickTabRef.current = tab;
		setPicking(true);
		pickTimer.current = setInterval(() => {
			const tab = pickTabRef.current;
			if (!tab) return;
			void tab.surface.evaluate(PICKER_READ_SCRIPT).then((raw) => {
				const data = parseJson<{ active?: boolean; pick?: { selector?: string; tag?: string; text?: string; cancelled?: boolean } | null }>(raw);
				if (!data) {
					stopPicking();
					return;
				}
				const pick = data.pick;
				if (pick?.selector) {
					stopPicking();
					insertElementRef({ selector: pick.selector, tag: pick.tag ?? '', text: pick.text ?? '' });
				} else if (pick?.cancelled || !data.active) {
					stopPicking();
				}
			}).catch(() => undefined);
		}, 200);
	};

	// 切换标签页时把地址栏同步成新活动页的地址（编辑中途不抢焦点、不强改）。
	useEffect(() => {
		setDraft(active?.url ?? '');
		setEditing(false);
		stopPicking();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active?.id]);

	useEffect(
		() => () => {
			if (pickTimer.current) clearInterval(pickTimer.current);
			pickTabRef.current?.surface.evaluate(PICKER_STOP_SCRIPT).catch(() => undefined);
		},
		[],
	);

	// 常驻宿主跟随占位区，但静止时不再每帧测量/重写 WebView 尺寸。
	// 路由过渡约 220ms，打开时短暂逐帧跟踪；拖拽、滚动和缩放由事件触发。
	// cleanup 可能与新面板的挂载重叠，所以存活面板的下一帧仍会恢复可见性。
	useEffect(() => {
		const placeholder = pageRef.current;
		const host = ensurePersistentHost();
		if (!placeholder) return;
		let raf = 0;
		let followUntil = performance.now() + 450;
		const schedule = () => { if (!raf) raf = requestAnimationFrame(sync); };
		const followTransition = () => {
			followUntil = Math.max(followUntil, performance.now() + 260);
			schedule();
		};
		const sync = () => {
			raf = 0;
			const r = placeholder.getBoundingClientRect();
			// 内缩 1px：占位区的边框留在页面四周，内容被宿主圆角裁齐
			const left = `${r.left + 1}px`;
			const top = `${r.top + 1}px`;
			const width = `${Math.max(1, r.width - 2)}px`;
			const height = `${Math.max(1, r.height - 2)}px`;
			if (host.style.left !== left) host.style.left = left;
			if (host.style.top !== top) host.style.top = top;
			if (host.style.width !== width) host.style.width = width;
			if (host.style.height !== height) host.style.height = height;
			if (host.style.visibility !== 'visible') host.style.visibility = 'visible';
			if (host.style.pointerEvents !== 'auto') host.style.pointerEvents = 'auto';
			if (performance.now() < followUntil) schedule();
		};
		const observer = new ResizeObserver(followTransition);
		observer.observe(placeholder);
		window.addEventListener('resize', followTransition);
		window.addEventListener('scroll', followTransition, true);
		window.visualViewport?.addEventListener('resize', followTransition);
		schedule();
		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
			window.removeEventListener('resize', followTransition);
			window.removeEventListener('scroll', followTransition, true);
			window.visualViewport?.removeEventListener('resize', followTransition);
			host.style.visibility = 'hidden';
			host.style.pointerEvents = 'none';
			host.style.left = '-9999px';
		};
	}, []);

	const go = useCallback(
		async (raw: string) => {
			const url = resolveAddressInput(raw);
			if (!url) return;
			setError(null);
			let tab = getActiveTab();
			if (!tab) tab = createTab(kind);
			setDraft(url);
			try {
				await tab.surface.navigate(url);
				notifyTabs();
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[kind],
	);

	const createHomeTab = useCallback(() => {
		createTab(kind);
		void go(getSearchEngineHomeUrl());
	}, [go, kind]);

	// 默认开始页（/browser 全屏入口传入）：先让标签栏与工具栏完成首帧绘制，
	// 再在浏览器空闲期创建 guest。WebView/网页初始化会抢主线程和 GPU，
	// 与路由入场动画同时启动会被感知成整个应用卡住。
	useEffect(() => {
		if (!initialUrl || listTabs().length > 0) return;
		let cancelled = false;
		const openHome = () => {
			if (!cancelled && listTabs().length === 0) void go(initialUrl);
		};
		if (typeof window.requestIdleCallback === 'function') {
			const idle = window.requestIdleCallback(openHome, { timeout: 450 });
			return () => { cancelled = true; window.cancelIdleCallback(idle); };
		}
		const timer = window.setTimeout(openHome, 100);
		return () => { cancelled = true; window.clearTimeout(timer); };
	}, [go, initialUrl]);

	// Agent 的入口。挂成全局桥，桌面端主进程的 Browser 工具通过它落地动作。
	// 桥只随面板挂载存在：面板没开时主进程找不到它，会先派发事件把面板打开
	// 再重试（可见性归面板管，页面本体是常驻的，不受面板开关影响）。
	// 多标签页语义：所有页面动作默认落在**活动标签**上；params.tab 指定 id 时
	// 落到那个标签。另提供 tabs / new_tab / switch_tab / close_tab 四个管理动作。
	useEffect(() => {
		const bridge = {
			async call(action: string, params: Record<string, unknown> = {}) {
				const pickTab = (): BrowserTab => {
					const raw = params.tab;
					if (raw != null && raw !== '') {
						const t = getTabById(Number(raw));
						if (t) return t;
						throw new Error(`没有 id=${String(raw)} 的标签页（可先调 tabs 查看）`);
					}
					return getActiveTab() ?? createTab(kind);
				};
				const describe = (t: BrowserTab) => ({
					id: t.id,
					url: t.surface.currentUrl(),
					title: t.surface.title(),
					loading: t.loading,
				});
				switch (action) {
					case 'tabs':
						return { tabs: listTabs(), active: activeTabId };
					case 'new_tab': {
						const t = createTab(kind);
						const url = normalizeUrl(String(params.url ?? ''));
						if (url) {
							try {
								await t.surface.navigate(url);
							} catch (e) {
								closeTab(t.id);
								throw e;
							}
						}
						notifyTabs();
						return describe(t);
					}
					case 'switch_tab': {
						const t = getTabById(Number(params.tab ?? params.id));
						if (!t) throw new Error('switch_tab 需要有效的标签页 id（可先调 tabs 查看）');
						setActiveTab(t.id);
						return describe(t);
					}
					case 'close_tab': {
						const t = getTabById(Number(params.tab ?? params.id));
						if (!t) throw new Error('close_tab 需要有效的标签页 id（可先调 tabs 查看）');
						const closingActive = t.id === activeTabId;
						closeTab(t.id);
						const now = getActiveTab();
						return {
							ok: true,
							remaining: tabs.length,
							activated: closingActive ? (now ? describe(now) : null) : null,
						};
					}
					case 'open': {
						const url = normalizeUrl(String(params.url ?? ''));
						if (!url) throw new Error('open 需要 url');
						const t = pickTab();
						await t.surface.navigate(url);
						notifyTabs();
						return { url: t.surface.currentUrl() || url, title: t.surface.title() };
					}
					case 'read': {
						const s = pickTab().surface;
						const raw = await s.evaluate(READ_SCRIPT);
						const data = parseJson<{ title: string; url: string; text: string }>(raw);
						if (!data) throw new Error('读取页面内容失败');
						// 上限只是防止一次 IPC 拖回几 MB；真正的截断在工具层
						return { ...data, text: data.text.slice(0, 200000) };
					}
					case 'state': {
						const t = pickTab();
						const s = t.surface;
						// 先去页面里问一次（拿到实时地址/标题），再补上浏览器侧的状态
						let live: { title: string; url: string } | null = null;
						try {
							live = parseJson<{ title: string; url: string }>(await s.evaluate(STATE_SCRIPT));
						} catch {
							/* 跨源 iframe 读不到就用宿主侧的值 */
						}
						return {
							url: live?.url || s.currentUrl(),
							title: live?.title || s.title(),
							loading: t.loading,
							tab: t.id,
							tabs: listTabs(),
							canGoBack: s.canGoBack(),
							canGoForward: s.canGoForward(),
						};
					}
					case 'screenshot': {
						const s = pickTab().surface;
						if (!s.capture) {
							throw new Error(
								'截图只有桌面端的内置浏览器（<webview>）支持：浏览器兜底模式（iframe）读不到跨源页面的像素。',
							);
						}
						return { data_url: await s.capture(), title: s.title(), url: s.currentUrl() };
					}
					case 'click': {
						const s = pickTab().surface;
						const selector = String(params.selector ?? '');
						await waitForSelector(s, selector);
						const data = parseJson<{ matched: number }>(await s.evaluate(CLICK_SCRIPT(selector)));
						return { matched: data?.matched ?? 0 };
					}
					case 'type': {
						const s = pickTab().surface;
						const selector = String(params.selector ?? '');
						await waitForSelector(s, selector);
						const text = String(params.text ?? '');
						const data = parseJson<{ matched: number; applied?: boolean; method?: string }>(
							await s.evaluate(TYPE_SCRIPT(selector, text)),
						);
						let applied = data?.applied;
						if (applied) {
							// 静置一下再复查：SPA 初始化时会重建输入框，把刚填的值刷掉。
							// 当场 true、过后被清空，是"看起来成功了其实没有"的典型形态。
							await sleep(250);
							const again = parseJson<{ applied?: boolean }>(
								await s.evaluate(VERIFY_TEXT_SCRIPT(selector, text)),
							);
							applied = again?.applied ?? applied;
						}
						return { matched: data?.matched ?? 0, applied, method: data?.method };
					}
					case 'press': {
						const s = pickTab().surface;
						await s.evaluate(PRESS_SCRIPT(String(params.key ?? '')));
						return { ok: true };
					}
					case 'back': {
						const s = pickTab().surface;
						s.back();
						notifyTabs();
						return { url: s.currentUrl() };
					}
					case 'forward': {
						const s = pickTab().surface;
						s.forward();
						notifyTabs();
						return { url: s.currentUrl() };
					}
					case 'reload': {
						const s = pickTab().surface;
						s.reload();
						return { url: s.currentUrl() };
					}
					default:
						throw new Error(`未知的浏览器动作：${action}`);
				}
			}
		};
		(window as unknown as { __cocodeBrowser?: typeof bridge }).__cocodeBrowser = bridge;
		return () => {
			delete (window as unknown as { __cocodeBrowser?: typeof bridge }).__cocodeBrowser;
		};
	}, [kind]);

	const surfaceAction = (fn: (s: Surface) => void) => {
		const tab = getActiveTab();
		if (!tab) {
			setError(t('browserPanel.noTabAction'));
			return;
		}
		setError(null);
		try {
			fn(tab.surface);
			notifyTabs();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1.5 pb-2">
			{/* 标签页栏：各标签平铺（过长自动收缩截断），尾部是新建按钮；关闭按钮悬停才出现 */}
			<div className="flex min-w-0 items-stretch gap-x-1 overflow-x-auto">
				{infos.map((tab) => (
					<div
						key={tab.id}
						role="button"
						tabIndex={0}
						onClick={() => setActiveTab(tab.id)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') setActiveTab(tab.id);
						}}
						onAuxClick={(e) => {
							// 中键关闭：浏览器老惯例，成本为零
							if (e.button === 1) closeTab(tab.id);
						}}
						title={tab.url || tab.title}
						className={cn(
							'group flex h-7 min-w-0 max-w-36 basis-28 shrink cursor-pointer items-center gap-x-1 rounded-t-md border-x border-t px-2 text-[11px] outline-none',
							'focus-visible:ring-1 focus-visible:ring-ring',
							tab.active
								? 'border-border bg-background text-foreground'
								: 'border-transparent bg-surface-muted text-muted-foreground hover:text-foreground',
						)}
					>
						{tab.loading ? (
							<LoaderCircle className="size-3 shrink-0 animate-spin" />
						) : (
							<Globe className="size-3 shrink-0" />
						)}
						<span className="min-w-0 flex-1 truncate">{tab.title || tab.url || t('browserPanel.newTab')}</span>
						<button
							className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 hover:bg-sidebar-accent focus-visible:opacity-100 group-hover:opacity-100"
							aria-label={t('browserPanel.closeTab')}
							onClick={(e) => {
								e.stopPropagation();
								closeTab(tab.id);
							}}
						>
							<X className="size-3" />
						</button>
					</div>
				))}
				<Button
					variant="ghost"
					size="icon-sm"
					className="shrink-0 self-center"
					aria-label={t('browserPanel.createTab')}
					onClick={createHomeTab}
				>
					<Plus />
				</Button>
			</div>

			{/* 工具栏：后退/前进/刷新 + 地址胶囊。未编辑时显示紧凑地址（省协议），
			    点击后显示完整 URL 并全选，Esc 还原，回车导航（作用于活动标签） */}
			<div className="flex items-center gap-x-0.5">
				<Button
					variant="ghost"
					size="icon-sm"
					disabled={!nav.back}
					onClick={() => surfaceAction((s) => s.back())}
					aria-label={t('browserPanel.back')}
				>
					<ArrowLeft />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					disabled={!nav.forward}
					onClick={() => surfaceAction((s) => s.forward())}
					aria-label={t('browserPanel.forward')}
				>
					<ArrowRight />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					// 没加载过任何页面时禁用：webview 上「刷新一个不存在的页面」
					// 只能如实报错（见 createWebviewSurface 的 requireOpened）
					disabled={!current}
					onClick={() => surfaceAction((s) => s.reload())}
					aria-label={t('browserPanel.reload')}
				>
					{loading ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
				</Button>
				{enableElementPicker ? (
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={!current}
						aria-pressed={picking}
						className={cn(picking && 'bg-primary/10 text-primary')}
						title={t('browserPanel.pickElementHint')}
						onClick={() => (picking ? stopPicking() : void startPicking())}
						aria-label={t('browserPanel.pickElement')}
					>
						<SquareDashedMousePointer />
					</Button>
				) : null}
				<Button
					variant="ghost"
					size="icon-sm"
					disabled={!current}
					title={t('browserPanel.openInBrowserHint')}
					onClick={() => {
						if (current) window.open(current, '_blank', 'noopener,noreferrer');
					}}
					aria-label={t('browserPanel.openInBrowser')}
				>
					<ExternalLink />
				</Button>
				<div
					title={title || current || undefined}
					className={cn(
						'flex h-7 min-w-0 flex-1 items-center gap-x-1.5 rounded-rect px-2.5 transition-colors',
						editing ? 'bg-background ring-1 ring-ring' : 'bg-surface-muted',
					)}
				>
					{loading ? (
						<LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" />
					) : (
						<Globe className="size-3 shrink-0 text-muted-foreground" />
					)}
					<input
						className="h-full min-w-0 flex-1 cursor-text bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
						placeholder={t('browserPanel.urlPlaceholder')}
						value={editing ? draft : prettyUrl(draft)}
						readOnly={!editing}
						onFocus={(e) => {
							setEditing(true);
							e.currentTarget.select();
						}}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={() => setEditing(false)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								setEditing(false);
								void go(draft);
							}
							if (e.key === 'Escape') {
								setDraft(current);
								setEditing(false);
								e.currentTarget.blur();
							}
						}}
						spellCheck={false}
					/>
				</div>
			</div>

			{error ? (
				<div className="flex items-start gap-x-1.5 rounded-md border border-destructive bg-destructive-soft px-2 py-1.5 text-[11px] text-destructive">
					<TriangleAlert className="mt-0.5 size-3 shrink-0" />
					<span className="min-w-0 break-words">{error}</span>
				</div>
			) : null}

			{/* 页面占位区。真正的 webview 常驻在 body 下的宿主里（见模块级标签管理），
			    打开时逐帧对齐到这里；关闭/切页时宿主藏起来但页面不销毁。 */}
			<div
				ref={pageRef}
				data-browser-placeholder="true"
				className={cn(
					'min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background',
				)}
			/>

			{kind === 'iframe' ? (
				<p className="px-0.5 text-[10px] leading-relaxed text-muted-foreground">
					{t('browserPanel.iframeFallbackHint')}
				</p>
			) : null}
		</div>
	);
}
