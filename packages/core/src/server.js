// CoCode HTTP+SSE 服务：桌面端 / 浏览器端共用同一 API
// 仅绑定 127.0.0.1。POST /api/chat 以 SSE 流式返回 Agent 事件。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './config.js';
import { runAgent } from './agent.js';
import { createClient, chatCompletion } from './model.js';
import { createSession, listSessions, loadSession, saveSession, deleteSession } from './session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '..', '..', 'desktop', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** 进行中的会话运行：sessionId -> AbortController */
const running = new Map();

export function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      try { res.end(JSON.stringify({ error: e?.message || String(e) })); } catch { /* closed */ }
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

async function readBody(req) {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  if (!buf) return {};
  try { return JSON.parse(buf); } catch { throw new Error('请求体不是合法 JSON'); }
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  // ---------- 静态 UI ----------
  if (method === 'GET' && !path.startsWith('/api/')) {
    let file = path === '/' ? '/index.html' : path;
    const full = join(UI_DIR, file);
    if (!full.startsWith(UI_DIR)) return json(res, 403, { error: 'forbidden' });
    try {
      const data = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
      return res.end(data);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }

  // ---------- 配置 ----------
  if (path === '/api/config' && method === 'GET') {
    const cfg = loadConfig();
    return json(res, 200, { ...cfg, apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}` : '', hasApiKey: !!cfg.apiKey });
  }
  if (path === '/api/config' && method === 'PUT') {
    const body = await readBody(req);
    // 掩码值不覆盖真实 key
    if (typeof body.apiKey === 'string' && /…/.test(body.apiKey)) delete body.apiKey;
    const cfg = saveConfig(body);
    return json(res, 200, { ok: true, model: cfg.model, baseURL: cfg.baseURL });
  }
  if (path === '/api/config/test' && method === 'POST') {
    try {
      const body = await readBody(req);
      // 允许用未保存的表单值测试（掩码值除外）
      const cfg = loadConfig();
      if (body.baseURL) cfg.baseURL = body.baseURL;
      if (body.model) cfg.model = body.model;
      if (body.apiKey && !/…/.test(body.apiKey)) cfg.apiKey = body.apiKey;
      const client = createClient(cfg);
      const t0 = Date.now();
      const { message, usage } = await chatCompletion(client, {
        messages: [{ role: 'user', content: 'ping，请只回复 pong' }]
      });
      return json(res, 200, { ok: true, latencyMs: Date.now() - t0, reply: message.content.slice(0, 50), usage });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  // ---------- 会话 ----------
  let m;
  if (path === '/api/sessions' && method === 'GET') return json(res, 200, listSessions());
  if (path === '/api/sessions' && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, createSession(body.title));
  }
  if ((m = path.match(/^\/api\/sessions\/([\w-]+)$/))) {
    const [, id] = m;
    if (method === 'GET') {
      const s = loadSession(id);
      return s ? json(res, 200, s) : json(res, 404, { error: '会话不存在' });
    }
    if (method === 'DELETE') return json(res, 200, { ok: deleteSession(id) });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const s = loadSession(id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      if (typeof body.title === 'string') s.title = body.title.slice(0, 40);
      if ('cwd' in body) s.cwd = body.cwd ?? null;
      return json(res, 200, saveSession(s));
    }
  }

  // ---------- 聊天（SSE 流式 Agent 事件）----------
  if (path === '/api/chat' && method === 'POST') {
    const body = await readBody(req);
    const { sessionId, content } = body;
    if (!sessionId || typeof content !== 'string' || !content.trim()) {
      return json(res, 400, { error: '需要 sessionId 与 content' });
    }
    if (running.has(sessionId)) return json(res, 409, { error: '该会话正在运行中' });
    const session = loadSession(sessionId);
    if (!session) return json(res, 404, { error: '会话不存在' });

    const cfg = loadConfig();
    session.messages.push({ role: 'user', content });
    saveSession(session);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'start', sessionId });

    const ac = new AbortController();
    running.set(sessionId, ac);
    const keepAlive = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { ac.abort(); clearInterval(keepAlive); });

    // SSE 流式执行。工作目录：优先会话里 PATCH 过的 cwd，其次该进程的 cwd
    // （这是 CLI 风格的简化服务，没有 GUI 的"选择文件夹"流程）
    const cwd = session.cwd || null;
    try {
      for await (const ev of runAgent({ cfg, cwd, messages: session.messages, signal: ac.signal })) {
        send(ev);
        if (ev.type === 'done') break;
      }
    } catch (e) {
      send({ type: 'error', error: e?.message || String(e) });
    } finally {
      clearInterval(keepAlive);
      running.delete(sessionId);
      saveSession(session); // 持久化（messages 已被 runAgent 就地追加）
      send({ type: 'session-saved', messageCount: session.messages.length, title: session.title });
      res.end();
    }
    return;
  }

  // ---------- 中止 ----------
  if ((m = path.match(/^\/api\/chat\/([\w-]+)\/abort$/)) && method === 'POST') {
    const ac = running.get(m[1]);
    if (!ac) return json(res, 404, { error: '无进行中的任务' });
    ac.abort();
    return json(res, 200, { ok: true });
  }

  // ---------- 任务状态 ----------
  if (path === '/api/running' && method === 'GET') {
    return json(res, 200, [...running.keys()]);
  }

  json(res, 404, { error: 'not found' });
}

// ---- CLI 直跑入口：node server.js [port] ----
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = Number(process.argv[2] || 3210);
  startServer({ port }).then((srv) => {
    const addr = srv.address();
    console.log(`CoCode 服务已启动: http://127.0.0.1:${addr.port}`);
    console.log('（桌面端 UI 路径 packages/desktop/ui，可浏览器直接打开）');
  });
}
