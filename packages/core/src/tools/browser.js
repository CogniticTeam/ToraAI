// Browser 工具：驱动「内置浏览器」。
//
// 为什么不是"自己起一个浏览器"：core 是零依赖的，而且经常跑在没有界面的进程里
// （CLI、无头服务、测试）。真正的浏览器实例属于桌面端 —— Electron 渲染层里的
// <webview>。所以这里把"驱动"做成**可注册**的：桌面端启动时注入一个 driver，
// 由它把调用转发到那个 webview。
//
// 没有 driver 时工具**不会假装成功**：它会明确说清"现在没有可用的内置浏览器"，
// 并指出替代方案。假成功比报错更糟 —— 模型会以为页面真的打开了，然后在错误的
// 前提上继续干活。
//
// 与 WebFetch 的分工：
//   WebFetch  取 HTML → 转纯文本。快、省 token，但拿不到 JS 渲染后的内容，也不能交互。
//   Browser   走真实浏览器。能跑 JS、能点击、能登录、能翻页 —— 代价是慢得多。
// 需要"看内容"用 WebFetch，需要"操作页面"或"页面是 JS 渲染的"才用 Browser。

import { assertHttpUrl } from './web.js';

/** 驱动签名：driver(action, params) → Promise<object>，失败时 throw。 */
let driver = null;

/**
 * 注册内置浏览器驱动（桌面端在创建窗口后调用）。
 * @param {((action: string, params: object) => Promise<object>) | null} fn
 */
export function setBrowserDriver(fn) {
  driver = typeof fn === 'function' ? fn : null;
}

export function clearBrowserDriver() {
  driver = null;
}

export function hasBrowserDriver() {
  return !!driver;
}

/**
 * 可用动作。read/state/screenshot 是"看"，open/back/forward/reload 是"导航"，
 * click/type/press 是"操作"，tabs/new_tab/switch_tab/close_tab 是"多标签页管理"。
 */
export const BROWSER_ACTIONS = [
  'open',
  'read',
  'state',
  'screenshot',
  'click',
  'type',
  'press',
  'back',
  'forward',
  'reload',
  'tabs',
  'new_tab',
  'switch_tab',
  'close_tab'
];

/** 导航类动作（只读语义）：它们不改变远端状态，只是换一页看。 */
const NAV_ACTIONS = new Set(['open', 'back', 'forward', 'reload', 'new_tab']);

/** 标签管理类动作：作用于本地标签集合，不改变任何远端状态。 */
const TAB_ACTIONS = new Set(['tabs', 'new_tab', 'switch_tab', 'close_tab']);

/**
 * 该动作算"写"还是"读"（供权限分类使用）。
 *
 * 导航（open/back/forward/reload）算读：它只换一页看，不改变远端状态，
 * 与 WebFetch 同类。click/type/press 算写：它们可能提交表单、删除数据、
 * 触发任何服务端副作用 —— 默认权限下应当经过用户确认。
 * 标签管理（tabs/new_tab/switch_tab/close_tab）也算读：只动本地标签集合，
 * 不触碰页面内容，更不会触达远端。
 */
export function browserIsWrite(action) {
  return action === 'click' || action === 'type' || action === 'press';
}

/**
 * 补全协议并校验。
 *
 * 为什么比 WebFetch 宽松一点：Browser 是"地址栏"语义 —— 用户/模型写
 * `example.com` 是极自然的输入，非要它补全 `https://` 属于无谓的往返。
 * WebFetch 的入参通常是从页面里提取出来的完整 URL，所以那边保持严格。
 * 宽松的边界很清楚：**只补协议，不改变安全性** —— 带协议的
 * `file:` / `javascript:` 仍然被 assertHttpUrl 挡掉。
 */
function normalizeTarget(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('地址为空');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  const u = assertHttpUrl(withScheme);
  if (!u.hostname) throw new Error(`无法解析主机名：${raw}`);
  return u;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CHARS = 6000;

function unavailable() {
  return (
    '当前没有可用的内置浏览器 —— 它由桌面端（CoCode 应用）提供：应用会在创建窗口时把它接进来。\n' +
    '你现在大概在 CLI 或纯浏览器环境里。替代方案：\n' +
    '  · WebFetch 抓取页面并转成文本（静态页面足够用）\n' +
    '  · WebSearch 搜索；或把页面内容下载到本地后用 Read 看'
  );
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/** 把驱动返回的结构整理成人/模型都能读的一段文本。 */
function present(action, res, params, limit) {
  const r = res && typeof res === 'object' ? res : {};
  const title = r.title ? String(r.title).trim() : '';
  const url = r.url ? String(r.url) : '';

  switch (action) {
    case 'open': {
      const head = title ? `已打开「${title}」` : '页面已打开';
      return `${head}\n${url}\n${r.message ? '\n' + r.message : ''}\n\n提示：想读正文用 action="read"；页面是 JS 渲染的也能读到（这是 Browser 相对 WebFetch 的价值）。`;
    }
    case 'read': {
      const text = String(r.text ?? '');
      const truncated = text.length > limit;
      const body = truncated ? text.slice(0, limit) : text;
      return (
        `# ${title || '(无标题)'}\n${url}\n\n${body}` +
        (truncated ? `\n\n…（正文共 ${text.length} 字符，已截断到 ${limit}；需要更多就调大 maxChars）` : '')
      );
    }
    case 'state':
      return [
        `地址：${url || '(空白页)'}`,
        `标题：${title || '(无)'}`,
        `加载中：${r.loading ? '是' : '否'}`,
        `可后退：${r.canGoBack ? '是' : '否'}　可前进：${r.canGoForward ? '是' : '否'}`,
        r.tab != null ? `标签页：#${r.tab}${Array.isArray(r.tabs) ? `（共 ${r.tabs.length} 个，action="tabs" 可看列表）` : ''}` : ''
      ]
        .filter(Boolean)
        .join('\n');
    case 'tabs': {
      const list = Array.isArray(r.tabs) ? r.tabs : [];
      if (!list.length) return '当前没有打开的标签页。用 action="new_tab"（或 "open"）开一个。';
      const lines = list.map((t) => {
        const flag = t.active ? '→' : ' ';
        const loading = t.loading ? ' [加载中]' : '';
        return `${flag} #${t.id} ${t.title || '(无标题)'} — ${t.url || '(空白页)'}${loading}`;
      });
      return `共 ${list.length} 个标签页（→ 是活动标签，页面动作默认作用于它；tab 参数可指定其他标签）：\n${lines.join('\n')}`;
    }
    case 'new_tab':
      return `已新建标签页 #${r.id}${title ? `「${title}」` : ''}\n${url || '(空白页)'}\n\n新标签已是活动标签，后续页面动作默认作用于此。`;
    case 'switch_tab':
      return `已切换到标签页 #${r.id}${title ? `「${title}」` : ''}\n${url || '(空白页)'}`;
    case 'close_tab': {
      const a = r.activated && typeof r.activated === 'object' ? r.activated : null;
      const now = a ? `\n当前活动标签：#${a.id} ${a.title || '(无标题)'} — ${a.url || '(空白页)'}` : '\n已没有打开的标签页。';
      return `已关闭标签页，剩余 ${Number(r.remaining ?? 0)} 个。${now}`;
    }
    case 'click': {
      const n = Number(r.matched ?? 0);
      if (!n) return `没有元素匹配 ${JSON.stringify(params.selector)} —— 检查选择器，或先 read/state 看看当前页面是不是预期那一页。`;
      return `已点击 ${params.selector}（匹配 ${n} 个，点了第一个）。${r.navigated ? '\n页面正在跳转。' : ''}`;
    }
    case 'type': {
      const n = Number(r.matched ?? 0);
      if (!n) return `没有元素匹配 ${JSON.stringify(params.selector)} —— 检查选择器。`;
      const text = JSON.stringify(String(params.text ?? '').slice(0, 80));
      // 值没落进去要如实说 —— 有些页面（富文本编辑器、被框架接管的输入框）
      // 会拒绝程序化输入，静默返回"已输入"会让模型以为填好了然后去提交。
      if (r.applied === false) {
        return (
          `已尝试在 ${params.selector} 输入 ${text}，但**输入框里的值没有变成目标文本**：` +
          '该页面可能用了富文本编辑器，或阻止了程序化输入。\n' +
          '可以试试：先 click 该元素再 type；或改用 press 逐键输入；或把内容读给用户让他手填。'
        );
      }
      return `已在 ${params.selector} 输入 ${text}。`;
    }
    case 'press':
      return `已按下 ${params.key}。${r.navigated ? '\n页面正在跳转。' : ''}`;
    default:
      return `${action} 完成。${url ? '\n' + url : ''}`;
  }
}

export const browserTool = {
  name: 'Browser',
  description:
    '操作内置浏览器（桌面端那个真实浏览器）。适合 WebFetch 做不到的事：JS 渲染的页面、需要点击/输入/登录、需要翻页后再读。' +
    'action=open 打开网址；read 读当前页正文；screenshot 截取当前画面（返回图像，能看出布局/样式问题——文本 read 看不出来）；' +
    'click 点元素；type 输入；press 按键；back/forward/reload 导航；state 看当前地址与标题。' +
    '支持多标签页：tabs 列出所有标签、new_tab 新建（可带 url）、switch_tab/close_tab 切换与关闭（需要 tab 参数指定 id）；' +
    '页面动作默认作用于活动标签，用 tab 参数可指定目标标签。' +
    '只支持 http/https。若只是想快速看一篇文章的内容，优先用 WebFetch（更快、更省 token）。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: BROWSER_ACTIONS,
        description: '要做的动作'
      },
      url: { type: 'string', description: 'open 要打开的地址（http/https）；new_tab 可选的初始地址' },
      tab: { type: 'number', description: '目标标签页 id（页面动作缺省为活动标签；switch_tab/close_tab 必填）' },
      selector: { type: 'string', description: 'click / type 的 CSS 选择器' },
      text: { type: 'string', description: 'type 要输入的文本' },
      key: { type: 'string', description: 'press 的按键名，例如 Enter、Escape、Tab' },
      maxChars: { type: 'number', description: `read 返回正文的字符上限（默认 ${DEFAULT_MAX_CHARS}）` }
    },
    required: ['action']
  },

  async execute(args, ctx = {}) {
    if (!driver) return unavailable();

    const action = String(args?.action ?? '').trim();
    if (!BROWSER_ACTIONS.includes(action)) {
      return `未知的 action：${action || '(空)'}。可用：${BROWSER_ACTIONS.join(' / ')}`;
    }

    const params = { ...args };

    if (action === 'open') {
      if (!params.url) return 'open 需要 url 参数。';
      try {
        // 与 WebFetch 共用同一套协议策略（只允许 http/https），额外补全缺省协议
        params.url = normalizeTarget(params.url).href;
      } catch (e) {
        return `地址不合法：${e.message}`;
      }
    }
    if (action === 'new_tab' && params.url) {
      try {
        params.url = normalizeTarget(params.url).href;
      } catch (e) {
        return `地址不合法：${e.message}`;
      }
    }
    if ((action === 'switch_tab' || action === 'close_tab') && params.tab == null) {
      return `${action} 需要 tab 参数（标签页 id，可先用 action="tabs" 查看）。`;
    }
    if (params.tab != null && !Number.isFinite(Number(params.tab))) {
      return `tab 参数需要是标签页 id（数字）：${params.tab}`;
    }
    if (action === 'click' && !params.selector) return 'click 需要 selector 参数。';
    if (action === 'type' && !params.selector) return 'type 需要 selector 参数。';
    if (action === 'press' && !params.key) return 'press 需要 key 参数。';
    if (action === 'type' && params.text == null) return 'type 需要 text 参数（可以为空字符串）。';

    const limit = clampInt(params.maxChars, 200, 60000, DEFAULT_MAX_CHARS);
    const timeoutMs = clampInt(ctx.cfg?.browserTimeout, 1000, 120000, DEFAULT_TIMEOUT_MS);

    try {
      const res = await withTimeout(driver(action, params), timeoutMs, `浏览器 ${action}`);
      if (action === 'screenshot') {
        // 截图走多模态通道：{text, image} 由 agent.js 拆成文本 + image_url part。
        // data_url 必须真的是图像 —— 驱动/序列化任何一环坏了都可能给出空串或
        // 普通对象，静默当成功会让模型对着一张不存在的图继续推理。
        const dataUrl = res && typeof res === 'object' ? String(res.data_url ?? '') : '';
        if (!dataUrl.startsWith('data:image/')) {
          const why = res && typeof res === 'object' && res.error ? `：${res.error}` : '';
          return `截图失败${why}。页面可能还没渲染出内容，或当前环境不支持在浏览器面板上截图 —— 可以先用 read 拿文本内容顶一下。`;
        }
        const head = res.title ? `已截取「${res.title}」` : '已截取当前页面';
        return {
          text: `${head}\n${res.url || ''}\n\n图像已作为输入附上，可直接查看。布局/样式类的问题（元素重叠、留白异常、渲染错乱）从这里看最直观。`,
          image: { media_type: 'image/png', data_url: dataUrl }
        };
      }
      return present(action, res, params, limit);
    } catch (e) {
      const msg = e?.message || String(e);
      // 超时/页面没起来的提示要能指导下一步，而不是只说"失败了"
      const hint =
        TAB_ACTIONS.has(action) && action !== 'new_tab'
          ? '标签页 id 可能已不存在 —— 先用 action="tabs" 看当前有哪些标签。'
          : NAV_ACTIONS.has(action)
            ? '页面可能加载很慢或打不开 —— 可以先用 state 看当前地址，或换 WebFetch 试试。'
            : '页面结构可能和预期不同 —— 先用 read 看看当前页内容，再决定选择器。';
      return `浏览器操作失败（${action}）：${msg}\n${hint}`;
    }
  }
};

export const browserTools = [browserTool];
