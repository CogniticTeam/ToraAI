// 联网工具：WebFetch（抓网页）+ WebSearch（搜索）
//
// 零依赖：只用 Node 内置 fetch（>=18）。HTML 用正则粗提取 —— 目标不是
// 完美还原 DOM，而是把「人能读的正文」低 token 地喂给模型。
import { redact } from '../security.js';

// 用真实形态的 Chrome UA：大量站点（含搜索引擎的 html 版）会按 UA 拒绝
// 非浏览器流量 —— 之前带 "CoCode/0.1" 的 UA 是「fetch failed / 403」的高发原因。
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT = 20000;

// ---------------------------------------------------------- fetcher 注入
//
// Node 内置 fetch（undici）**不读系统代理**，也不走系统证书库 —— 桌面版
// 用户在系统代理/公司证书环境下会大面积「fetch failed」。Electron 的
// net.fetch 走 Chromium 网络栈（系统代理 + 系统证书），由 main.js 在
// app ready 后注入进来；CLI 环境保持 globalThis.fetch 不变。
// 注意运行时读取而非模块加载时固化：测试用例靠替换 globalThis.fetch 生效。
let injectedFetcher = null;
export function setWebFetcher(fn) { injectedFetcher = typeof fn === 'function' ? fn : null; }

function doFetch(url, init) {
  if (injectedFetcher) return injectedFetcher(url, init);
  return globalThis.fetch(url, init);
}

/**
 * 把 undici 层层包裹的 fetch 错误（`TypeError: fetch failed` + cause 链）
 * 翻译成人能看懂的排查方向。cause 链可能多层（如 fetch failed →
 * connect → getaddrinfo ENOTFOUND），沿链找第一个带 code 的错误定类。
 */
export function describeFetchError(e, timeout) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `请求超过 ${timeout}ms 未响应（站点太慢或网络不通，可稍后重试）`;
  }
  const causes = [];
  let c = e;
  while (c && causes.length < 8) { causes.push(c); c = c.cause; }
  const withCode = causes.find((x) => x?.code);
  const code = withCode?.code || '';
  const detail = (withCode?.message || e?.message || String(e)).trim();
  const HINTS = {
    ENOTFOUND: '域名无法解析（不存在、拼写有误，或当前网络的 DNS 拦了它）',
    EAI_AGAIN: '域名解析暂时失败（DNS 服务不可用或网络波动）',
    ECONNREFUSED: '目标端口没有服务在监听（服务未启动或端口不对）',
    ECONNRESET: '连接被目标站或中间设备强制断开（常见于站点拒绝非浏览器流量或网络被拦截）',
    EPROTO: 'TLS 握手失败（站点证书异常，或中间设备拦截了 HTTPS）',
    ETIMEDOUT: '连接超时（目标不可达或被防火墙丢弃）',
    UND_ERR_CONNECT_TIMEOUT: '连接超时（目标不可达或被防火墙丢弃）',
    UND_ERR_SOCKET: '连接中途断开',
    CERT_HAS_EXPIRED: '站点证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: '站点使用自签名证书，无法通过校验',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '站点证书链无法校验',
  };
  const reason = HINTS[code] || detail || '未知网络错误';
  const proxyHint = injectedFetcher
    ? ''
    : '若你的网络需要代理才能上网：Node 直连不走系统代理，可设置 HTTPS_PROXY/HTTP_PROXY 环境变量后重启，或改用桌面端（已走系统代理）。';
  return `${reason}${code ? ` [${code}]` : ''}。${proxyHint}`;
}

function truncate(s, limit) {
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.75);
  const tail = Math.floor(limit * 0.2);
  return `${s.slice(0, head)}\n…[已截断 ${s.length - head - tail} 字符，如需更多请用更精确的 URL 或减少 max_chars]…\n${s.slice(-tail)}`;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  '#34': '"', '#x27': "'", '#x2F': '/', mdash: '—', ndash: '–', hellip: '…',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', copy: '©'
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (m, code) => {
    if (ENTITIES[code] != null) return ENTITIES[code];
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/** 极简 HTML → 纯文本 */
export function htmlToText(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/blockquote)[^>]*>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|section|article|blockquote|pre)[^>]*>/gi, '\n')
    .replace(/<t[dh][^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 从 <title> 里拿标题（搜索结果展示用） */
function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

export function assertHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`无法解析 URL：${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只允许 http/https 协议（收到 ${u.protocol}）—— file:// 等本地协议被拒绝。`);
  }
  return u;
}

// ------------------------------------------------------------- WebFetch

export const webFetchTool = {
  name: 'WebFetch',
  description:
    '抓取一个 http(s) URL 并返回可读正文（HTML 会转成纯文本）。用于查文档、看报错页面、读最新 API 说明。' +
    '不要用它访问内网地址；返回内容可能被截断，必要时用 max_chars 调整。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的完整 URL（http/https）' },
      max_chars: { type: 'number', description: '返回正文的最大字符数，默认沿用工具输出上限' },
      raw: { type: 'boolean', description: 'true = 返回原始响应体（不转纯文本），默认 false' }
    },
    required: ['url']
  },
  async execute({ url, max_chars, raw = false }, ctx) {
    let u;
    try { u = assertHttpUrl(url); } catch (e) { return `抓取失败: ${e.message}`; }
    const limit = Number.isFinite(max_chars) ? Math.max(500, Math.min(max_chars, 200000))
      : (ctx?.toolOutputLimit ?? 6000);
    const timeout = ctx?.webTimeout ?? DEFAULT_TIMEOUT;
    let res;
    try {
      res = await doFetch(u.toString(), {
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(timeout)
      });
    } catch (e) {
      return `抓取失败: ${describeFetchError(e, timeout)}`;
    }
    let body = '';
    try { body = await res.text(); } catch (e) { return `读取响应失败: ${e?.message || e}`; }
    const ctype = res.headers.get('content-type') || '';
    let text = body;
    if (!raw && /html/i.test(ctype)) {
      const title = extractTitle(body);
      text = (title ? `# ${title}\n\n` : '') + htmlToText(body);
    } else if (!raw && /json/i.test(ctype)) {
      try { text = JSON.stringify(JSON.parse(body), null, 2); } catch { /* 保留原文 */ }
    }
    const header = `GET ${u.toString()}\nstatus: ${res.status} ${res.statusText}\ncontent-type: ${ctype || 'unknown'}\n`;
    return redact(header + '\n' + truncate(text, limit));
  }
};

// ------------------------------------------------------------ WebSearch

function decodeDdgRedirect(href) {
  if (!href) return '';
  try {
    const abs = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(abs, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : abs;
  } catch { return href; }
}

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** 解析 duckduckgo html 版（result__a / result__snippet） */
export function parseDdgHtml(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1200}?)(?=<a[^>]+class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>|$)/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = decodeDdgRedirect(m[1]);
    const title = stripTags(m[2]);
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(m[3]);
    const snippet = snip ? stripTags(snip[1]) : '';
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet });
  }
  return out;
}

/** 解析 duckduckgo lite 版 */
export function parseDdgLite(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,900}?class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = decodeDdgRedirect(m[1]);
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet });
  }
  return out;
}

export const webSearchTool = {
  name: 'WebSearch',
  description:
    '用搜索引擎查资料，返回若干条「标题 + URL + 摘要」。用于查最新 API、报错信息、库版本。' +
    '拿到 URL 后可以用 WebFetch 读正文。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '返回条数，默认 8，最多 20' }
    },
    required: ['query']
  },
  async execute({ query, limit = 8 }, ctx) {
    const q = String(query ?? '').trim();
    if (!q) return '搜索失败: query 不能为空。';
    const n = Math.max(1, Math.min(Number(limit) || 8, 20));
    const timeout = ctx?.webTimeout ?? DEFAULT_TIMEOUT;
    const endpoints = [
      { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDdgHtml },
      { url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDdgLite }
    ];
    let lastErr = '';
    for (const ep of endpoints) {
      try {
        const res = await doFetch(ep.url, {
          headers: { 'user-agent': UA, accept: 'text/html' },
          signal: AbortSignal.timeout(timeout)
        });
        if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
        const html = await res.text();
        const hits = ep.parse(html).slice(0, n);
        if (!hits.length) { lastErr = '未解析到结果'; continue; }
        const lines = hits.map((h, i) =>
          `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet.slice(0, 300)}` : ''}`);
        return redact(`搜索「${q}」共 ${hits.length} 条：\n\n${lines.join('\n\n')}`);
      } catch (e) {
        lastErr = describeFetchError(e, timeout);
      }
    }
    return `搜索失败: ${lastErr || '未知错误'}。可以改用 WebFetch 直接抓取已知文档 URL。`;
  }
};

export const webTools = [webFetchTool, webSearchTool];
