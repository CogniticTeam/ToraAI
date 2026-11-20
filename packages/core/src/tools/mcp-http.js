import { randomUUID } from 'node:crypto';

const PROTOCOL = '2025-06-18';
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const reservedHeaders = new Set(['host', 'accept', 'accept-encoding', 'connection', 'content-type', 'content-length', 'cookie', 'proxy-authorization', 'transfer-encoding', 'upgrade', 'mcp-session-id', 'mcp-protocol-version']);
let transportFetch = (...args) => globalThis.fetch(...args);

export function setMcpHttpFetcher(fetcher) {
  transportFetch = fetcher ?? ((...args) => globalThis.fetch(...args));
}

export function normalizeMcpEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.hash || url.search) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeMcpHeaders(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 20) return null;
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(raw)) {
      const lower = name.toLowerCase();
      if (reservedHeaders.has(lower) || headers.has(lower) || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) return null;
      headers.set(lower, value);
    }
    return Object.fromEntries(headers);
  } catch { return null; }
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('MCP 响应 JSON 无效'); }
}

async function readReply(response, id) {
  if (!response.body) throw new Error('MCP 响应为空');
  const type = response.headers.get('content-type') ?? '';
  const stream = type.includes('text/event-stream');
  if (!stream && !type.includes('application/json')) {
    await response.body.cancel().catch(() => {});
    throw new Error('MCP 响应格式不受支持');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let buffer = '';
  let data = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) total += value.byteLength;
      if (total > RESPONSE_LIMIT) throw new Error('MCP 响应超过大小限制');
      buffer += decoder.decode(value, { stream: !done });
      if (!stream && done) return parseJson(buffer);
      if (stream) {
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '');
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          if (!line && data.length) {
            const value = parseJson(data.join('\n'));
            data = [];
            if (value?.id === id) return value;
          }
        }
      }
      if (done) throw new Error('MCP 事件流未返回工具响应');
    }
  } finally {
    // Servers can keep the SSE response open after the requested reply.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class McpHttpConnection {
  constructor(name, definition, onStop) {
    this.name = name;
    this.definition = definition;
    this.onStop = onStop;
    this.lifecycle = new AbortController();
    this.alive = true;
    this.tools = null;
    this.toolNames = null;
    this.starting = null;
    this.session = '';
    this.protocol = '';
    this.idleTimer = null;
  }

  start() {
    this.starting ??= this.#initialize().catch(error => { this.stop(); throw error; });
    return this.starting;
  }

  async #initialize() {
    this.keepAlive();
    const initialized = await this.#post('initialize', {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'tora', version: '1.1.1' },
    }, { timeoutMs: 8000, initializing: true });
    if (!['2025-03-26', PROTOCOL, '2025-11-25'].includes(initialized?.protocolVersion)) throw new Error('MCP 协议版本不受支持');
    this.protocol = initialized.protocolVersion;
    await this.#post('notifications/initialized', {}, { timeoutMs: 8000, notification: true });
    const tools = new Map();
    let cursor;
    for (let page = 0; page < 8; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: 8000 });
      if (!Array.isArray(result?.tools)) throw new Error('MCP 工具清单无效');
      for (const tool of result.tools) {
        if (typeof tool?.name === 'string' && tool.name && !tools.has(tool.name)) tools.set(tool.name, tool);
        if (tools.size >= 300) break;
      }
      if (tools.size >= 300 || typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    this.tools = [...tools.values()];
    this.toolNames = [...tools.keys()];
  }

  #headers() {
    const headers = new Headers(this.definition.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    if (this.session) headers.set('mcp-session-id', this.session);
    if (this.protocol) headers.set('mcp-protocol-version', this.protocol);
    return headers;
  }

  async #post(method, params, { signal, timeoutMs = 30000, initializing = false, notification = false } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([this.lifecycle.signal, timeout, ...(signal ? [signal] : [])]);
    const id = notification ? undefined : randomUUID();
    try {
      const response = await transportFetch(this.definition.url, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: combined, headers: this.#headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 404 && this.session) this.stop(false);
        throw new Error(response.status === 401 || response.status === 403 ? 'MCP 服务器拒绝授权，请检查凭证' : `MCP HTTP ${response.status}`);
      }
      if (initializing) {
        const session = response.headers.get('mcp-session-id');
        if (session && /^[\x21-\x7e]{1,512}$/.test(session)) this.session = session;
      }
      if (notification) { void response.body?.cancel().catch(() => {}); return; }
      const reply = await readReply(response, id);
      if (reply?.id !== id || reply.jsonrpc !== '2.0') throw new Error('MCP 响应标识不匹配');
      if (reply.error) throw new Error(`MCP 服务器返回错误${Number.isInteger(reply.error.code) ? ` (${reply.error.code})` : ''}`);
      if (!Object.hasOwn(reply, 'result')) throw new Error('MCP 响应缺少结果');
      return reply.result;
    } catch (error) {
      if (signal?.aborted || (!this.alive && this.lifecycle.signal.aborted && !error.message?.startsWith('MCP HTTP'))) {
        throw Object.assign(new Error('MCP 请求已中止'), { code: 'ABORTED' });
      }
      if (timeout.aborted) throw Object.assign(new Error('MCP 请求超时'), { code: 'MCP_TIMEOUT' });
      throw error;
    }
  }

  request(method, params, options) {
    return this.#post(method, params, options);
  }

  keepAlive() {
    if (!this.alive) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), 5 * 60 * 1000);
    this.idleTimer.unref?.();
  }

  stop(endSession = true) {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.idleTimer);
    this.lifecycle.abort();
    this.onStop(this);
    if (endSession && this.session) {
      void transportFetch(this.definition.url, {
        method: 'DELETE', headers: this.#headers(), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(3000),
      }).then(response => response.body?.cancel()).catch(() => {});
    }
  }
}
