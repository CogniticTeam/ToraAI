// CoCode 登录/注册服务（Cloudflare Worker + D1 + Resend 邮件）。
//
// 端点：
//   POST /auth/check     {account: 用户名或邮箱}          -> {registered, email?, username?}
//   POST /auth/code      {email}（未注册邮箱）            -> {ok}   发送 6 位验证码（10 分钟有效，60s 冷却）
//   POST /auth/register  {email, username, password, code} -> {token, email, username, createdAt, avatar}
//   POST /auth/login     {account: 用户名或邮箱, password}  -> {token, email, username, createdAt, avatar}
//   GET  /auth/me        (Bearer token)     -> {email, username, createdAt, avatar}
//   POST /auth/logout    (Bearer token)     -> {ok}
//   POST /auth/password  (Bearer) {currentPassword, newPassword} -> {ok}
//   POST /auth/email     (Bearer) {currentPassword, newEmail, code}    -> {ok, email}
//   POST /auth/avatar    (Bearer) {avatar: dataURL|null}          -> {ok, avatar}
//   GET    /models       (Bearer)  -> {models:[{id,provider,label,model,baseURL,apiKeySet,enabled,vision}]}
//   POST   /models       (Bearer)  {models:[..],baseURL,provider,label,apiKey?,vision?} -> {added,updated}
//   PATCH  /models/:id   (Bearer)  {model?,baseURL?,apiKey?,label?,enabled?,vision?}    -> {ok}
//   DELETE /models/:id   (Bearer)  -> {ok}
//
// 模型列表（设置→模型板块）以云端为权威存储，一账号一列表、跨设备同步；
// 本地 config.modelList 只是运行时镜像（core 读它合成凭证），由前端登录后
// 从云端拉取覆盖。
//
// 环境变量：
//   RESEND_API_KEY（wrangler secret put RESEND_API_KEY；本地 dev 写 .dev.vars）
//   TURNSTILE_SECRET（wrangler secret put TURNSTILE_SECRET）——Cloudflare
//     Turnstile 人机验证 secret。登录/注册端点强制校验；未配置时跳过（本地 dev 降级）。
//   TURNSTILE_HOSTNAMES（可选，逗号分隔）——siteverify 返回 hostname 白名单；
//     未配置默认 "127.0.0.1,localhost,ohfun.online"（桌面客户端 token 的 hostname
//     为 127.0.0.1；生产收紧时删掉本地项即可）。
// 发件人：noreply@cocode.ohfun.online（自定义域名路由，见 wrangler.toml）
//
// 设计取舍：
//   · 密码哈希用 WebCrypto 的 PBKDF2（SHA-256，210k 次迭代）——Workers 里
//     没有 bcrypt/argon2 的原生实现，PBKDF2 是 OWASP 认可的纯 WebCrypto 方案。
//   · 会话 = 随机 48 字节 hex token，存 D1，30 天过期；不设 refresh token
//     （桌面客户端，过期重新登录即可）。
//   · 表结构在首个请求时自动建立（CREATE TABLE IF NOT EXISTS），免迁移命令。

// 注册欢迎邮件模板：仓库根目录 cocode-hello-email.html（wrangler.toml 的 Text
// 规则支持直接 import 为字符串）。注意：改动本文件时勿删此 import 与下方
// sendWelcomeEmail——之前一次整体重写曾把它们弄丢，导致线上欢迎邮件静默失效。
import helloEmailHtml from '../../../cocode-hello-email.html';
import pollSchemaSql from '../migrations/0001_polls.sql';
import { publishAccountEvent } from './account-events.js';
import { detectMessageLanguage, translateAccountMessage } from './message-translation.js';
import { ensureMessageCampaigns, listSentMessages, recallMessage, sendMessage } from './admin-messages.js';
import { handleAdminPoll, handleUserPoll } from './polls.js';
export { AccountEvents } from './account-events.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// Cloudflare Workers 免费套餐对 PBKDF2 迭代次数的上限是 100,000，超过会抛
// OperationError（线上表现为 1101）。本地 wrangler dev 无此限制，勿调高。
const PBKDF2_ITERATIONS = 100_000;

// ---------- 工具 ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
  });
}

const bad = (message, status = 400) => json({ detail: message }, status);

function isRetiredOfficialModelURL(value) {
  return String(value ?? '').toLowerCase().includes('/official/v1');
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function isValidUsername(s) {
  // 2-32 位：字母/数字/下划线/连字符/中日韩文字；不含 @（避免和邮箱混淆）
  return typeof s === 'string' && /^[\p{L}\p{N}_-]{2,32}$/u.test(s) && !s.includes('@');
}

// ---------- Turnstile 人机验证 ----------
// 仅对 /auth/login 与 /auth/register 做门禁（注册链路里验证码发送等其余端点不拦）。
// siteverify 只能由后端调用；token 一次性，失败重试需前端 reset 换新 token。

const DEFAULT_TURNSTILE_HOSTNAMES = '127.0.0.1,localhost,ohfun.online';

/** 校验 Turnstile token；返回 false 一律 403。未配置 secret 时跳过（本地 dev 降级）。 */
async function verifyTurnstile(env, request, token, expectedAction) {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  const hostnames = new Set(
    (env.TURNSTILE_HOSTNAMES ?? DEFAULT_TURNSTILE_HOSTNAMES)
      .split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (hostnames.size === 0) return false;
  let result;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get('cf-connecting-ip') ?? '',
      }),
    });
    if (!r.ok) return false;
    result = await r.json();
  } catch {
    // siteverify 网络故障按拒绝处理（fail-closed）
    return false;
  }
  return result.success === true
    && result.action === expectedAction
    && hostnames.has(result.hostname);
}

// ---------- 邮箱验证码（Resend 发信） ----------

const CODE_TTL_MS = 10 * 60_000;
const CODE_RESEND_COOLDOWN_MS = 60_000;

async function sendVerificationCode(env, email) {
  const now = Date.now();
  const row = await env.DB
    .prepare('SELECT sent_at FROM verification_codes WHERE email = ?')
    .bind(email).first();
  if (row && now - row.sent_at < CODE_RESEND_COOLDOWN_MS) {
    return { ok: false, status: 429, detail: '发送过于频繁，请稍后再试' };
  }
  // crypto.getRandomValues 是 CSPRNG；Math.random 不抗预测，已弃用
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: 'CoCode <noreply@cocode.ohfun.online>',
      to: [email],
      subject: `CoCode 验证码：${code}`,
      html: [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">',
        '<h2 style="margin:0 0 12px;font-size:18px;">CoCode 注册验证码</h2>',
        `<p style="margin:0 0 20px;color:#555;">你的验证码如下，<strong>${CODE_TTL_MS / 60_000} 分钟</strong>内有效：</p>`,
        `<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:8px;color:#111;">${code}</p>`,
        '<p style="margin:0;color:#999;font-size:13px;">如果不是你本人操作，请忽略这封邮件。</p>',
        '</div>',
      ].join(''),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: 502, detail: `验证码发送失败：${detail.slice(0, 200)}` };
  }
  // 发送成功才落库（失败可立即重试，不占 60s 冷却）
  await env.DB.prepare(
    'INSERT INTO verification_codes (email, code, expires_at, sent_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, sent_at = excluded.sent_at'
  ).bind(email, code, now + CODE_TTL_MS, now).run();
  return { ok: true };
}

// ---------- 注册欢迎邮件（Resend 发信） ----------

// 发送失败仅记日志、不抛出——欢迎邮件不影响注册主流程。
async function sendWelcomeEmail(env, email) {
  if (!env.RESEND_API_KEY) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: 'CoCode <noreply@cocode.ohfun.online>',
      to: [email],
      subject: '欢迎加入 CoCode 🎉',
      html: helloEmailHtml,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`欢迎邮件发送失败（${email}）：${detail.slice(0, 200)}`);
    return;
  }
  console.log(`欢迎邮件已发送：${email}`);
}

const CODE_MAX_ATTEMPTS = 5;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60_000;

/** 校验并消费验证码（一次性：对上即删；错 5 次直接作废该 code，防暴力猜码） */
async function consumeVerificationCode(db, email, code) {
  const row = await db
    .prepare('SELECT code, expires_at, attempts FROM verification_codes WHERE email = ?')
    .bind(email).first();
  if (!row || row.expires_at < Date.now()) return false;
  if (String(code).trim() !== row.code) {
    const n = (row.attempts ?? 0) + 1;
    if (n >= CODE_MAX_ATTEMPTS) {
      await db.prepare('DELETE FROM verification_codes WHERE email = ?').bind(email).run();
    } else {
      await db.prepare('UPDATE verification_codes SET attempts = ? WHERE email = ?').bind(n, email).run();
    }
    return false;
  }
  await db.prepare('DELETE FROM verification_codes WHERE email = ?').bind(email).run();
  return true;
}

/** 登录失败计数：超限则锁定，防暴力破解 */
async function checkLoginLocked(db, account) {
  const r = await db.prepare('SELECT locked_until FROM login_attempts WHERE account = ?').bind(account).first();
  return !!(r && r.locked_until > Date.now());
}
async function recordLoginFail(db, account) {
  const r = await db.prepare('SELECT fails, locked_until FROM login_attempts WHERE account = ?').bind(account).first();
  const fails = (r?.fails ?? 0) + 1;
  const lock = fails >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : (r?.locked_until ?? 0);
  await db.prepare(
    'INSERT INTO login_attempts (account, fails, locked_until) VALUES (?, ?, ?) ' +
    'ON CONFLICT(account) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until'
  ).bind(account, fails, lock).run();
}
async function clearLoginFails(db, account) {
  await db.prepare('DELETE FROM login_attempts WHERE account = ?').bind(account).run();
}

async function ensureSchema(db) {
  // 三个表都幂等建；D1 的 batch 保证顺序执行
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS verification_codes (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      sent_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    )`),
    // 登录限速：按账号累计失败次数，达上限锁定一段时间（防暴力破解）
    db.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
      account TEXT PRIMARY KEY,
      fails INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0
    )`),
    // 用户模型列表（设置→模型板块的云端权威存储）。api_key 明文（与本地
    // config.json 现状一致），靠 token 鉴权 + HTTPS 传输保护。
    db.prepare(`CREATE TABLE IF NOT EXISTS user_models (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT,
      label TEXT,
      model TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      vision INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_models_user ON user_models(user_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS account_messages (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_account_messages ON account_messages(user_id, created_at DESC)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS message_translations (
      message_id TEXT NOT NULL REFERENCES account_messages(id) ON DELETE CASCADE,
      target_language TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (message_id, target_language)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS message_translation_limits (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      window INTEGER NOT NULL, total INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS account_tickets (
      ticket TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, session_expires INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, user_id INTEGER,
      detail TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
  ]);
  // 老库补列（ALTER 对已存在的列会抛错，吞掉即可）：
  //   avatar  —— dataURL 文本，前端上传前压到 128px JPEG（约 10-30KB）
  //   username —— 全局唯一登录名；一号一邮箱由 email UNIQUE 保证，
  //               用户名唯一由下面的唯一索引保证（SQLite 允许多个 NULL，老用户不受影响）
  //   attempts —— 验证码尝试次数，防暴力猜码
  try {
    await db.prepare('ALTER TABLE users ADD COLUMN avatar TEXT').run();
  } catch { /* 列已存在 */ }
  try {
    await db.prepare('ALTER TABLE users ADD COLUMN username TEXT').run();
  } catch { /* 列已存在 */ }
  try {
    await db.prepare('ALTER TABLE verification_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0').run();
  } catch { /* 列已存在 */ }
  await db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)'
  ).run();
  for (const column of ['batch_id TEXT', 'recalled_at TEXT']) {
    try { await db.prepare(`ALTER TABLE account_messages ADD COLUMN ${column}`).run(); }
    catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_account_message_batch ON account_messages(batch_id)').run();
  await ensureMessageCampaigns(db);
  for (const column of ['banned INTEGER NOT NULL DEFAULT 0', "ban_reason TEXT NOT NULL DEFAULT ''"]) {
    try { await db.prepare(`ALTER TABLE users ADD COLUMN ${column}`).run(); }
    catch (error) { if (!String(error).includes('duplicate column')) throw error; }
  }
  // 与部署时手动执行的 SQL 使用同一份迁移脚本；旧库首次启动也能幂等补表。
  // D1 exec 将换行视为语句分界，因此把每条多行 DDL 压为单行。
  const pollStatements = pollSchemaSql.split('\n').filter(line => !line.trim().startsWith('--'))
    .join(' ').split(';').map(statement => statement.trim()).filter(Boolean);
  await db.exec(pollStatements.join(';\n') + ';');
  // 旧版本自动发放的官方模型是生成数据；自定义模型模式下直接清理。
  await db.prepare(
    "DELETE FROM user_models WHERE id LIKE 'official-%' OR base_url LIKE '%/official/v1%'"
  ).run();
}

let schemaReady = false;

// ---------- 密码（PBKDF2） ----------

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = hexToBytes(saltHex);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

async function makeSalt() {
  const s = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(s);
}

function bytesToHex(u8) {
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- 会话 ----------

async function createSession(db, userId) {
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(48)));
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt).run();
  return token;
}

async function userFromRequest(db, req, allowBanned = false) {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const row = await db.prepare(
    'SELECT u.id, u.email, u.created_at, u.avatar, u.username, u.banned, u.ban_reason, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).bind(token).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  if (row.banned && !allowBanned) {
    const error = new Error(row.ban_reason || '账户已被封禁');
    error.code = 'ACCOUNT_BANNED';
    throw error;
  }
  return row;
}

/** 免费 CoCode 语音识别网关：仅接受登录用户的 GLM-ASR 转写请求。 */
async function handleAsrGateway(env, request, pathSuffix) {
  const user = await userFromRequest(env.DB, request);
  if (!user) return json({ detail: { message: '未登录或会话已过期' } }, 401);
  if (pathSuffix !== 'audio/transcriptions') return bad('Not Found', 404);
  if (request.method !== 'POST') return bad('Method Not Allowed', 405);
  const upstreamKey = env.ZHIPU_API_KEY;
  if (!upstreamKey) return json({ detail: { message: '语音识别暂未开放（服务端未配置上游密钥）' } }, 503);

  const headers = new Headers({ authorization: `Bearer ${upstreamKey}` });
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const upstream = await fetch('https://open.bigmodel.cn/api/paas/v4/audio/transcriptions', {
    method: 'POST',
    headers,
    body: request.body,
    signal: AbortSignal.timeout(180_000),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  });
}

// ---------- 路由 ----------

export default {
  async fetch(request, env, ctx) {
    try {
      // 官网已迁移到 Cloudflare Pages（ohfun.online，项目 cocode）。
      // 旧官网域名仍解析到本 Worker，这里统一 301 到 Pages 站点。
      const url = new URL(request.url);
      if (url.hostname === 'cocode-ai.ohfun.online') {
        const target = 'https://ohfun.online' + url.pathname + url.search;
        return Response.redirect(target, 301);
      }
      return await handle(request, env, ctx);
    } catch (e) {
      if (e?.code === 'ACCOUNT_BANNED') return json({ code: e.code, detail: e.message }, 403);
      // 兜底：任何未捕获异常都转成 500 JSON（而不是 Cloudflare 的 1101 错误页）
      return json({ detail: `服务内部错误：${e?.message ?? e}` }, 500);
    }
  },
};

async function handle(request, env, ctx) {
    if (!schemaReady) { await ensureSchema(env.DB); schemaReady = true; }
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '');
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
        },
      });
    }

    if (p === '/admin' && method === 'GET') {
      return Response.redirect('https://ohfun.online/admin', 302);
    }
    if (p.startsWith('/admin/')) {
      const key = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
      if (!env.ADMIN_TOKEN || !timingSafeEqual(key, env.ADMIN_TOKEN)) return bad('管理密钥无效', 401);
      if (p.startsWith('/admin/polls')) return handleAdminPoll(request, env, url);
      if (p === '/admin/users' && method === 'GET') {
        const search = (url.searchParams.get('q') || '').trim().slice(0, 254);
        const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const { results } = await env.DB.prepare("SELECT id, email, username, banned, ban_reason, created_at FROM users WHERE instr(lower(email), lower(?)) > 0 OR instr(lower(coalesce(username, '')), lower(?)) > 0 ORDER BY id DESC LIMIT 100 OFFSET ?").bind(search, search, offset).all();
        return json({ users: results, nextOffset: results.length === 100 ? offset + 100 : null });
      }
      const banMatch = p.match(/^\/admin\/users\/(\d+)\/ban$/);
      if (banMatch && method === 'POST') {
        const body = await request.json();
        if (typeof body.banned !== 'boolean') return bad('banned 必须为布尔值', 422);
        const userId = Number(banMatch[1]);
        const reason = body.banned ? String(body.reason || '').trim().slice(0, 500) : '';
        const result = await env.DB.prepare('UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?').bind(body.banned ? 1 : 0, reason, userId).run();
        if (!result.meta.changes) return bad('账户不存在', 404);
        await env.DB.prepare('INSERT INTO admin_audit (action, user_id, detail, created_at) VALUES (?, ?, ?, ?)').bind(body.banned ? 'ban' : 'unban', userId, reason, new Date().toISOString()).run();
        const push = await publishAccountEvent(env, userId, { type: 'account-changed' });
        return json({ ok: true, ...push });
      }
      if (p === '/admin/messages' && method === 'GET') {
        const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        return json(await listSentMessages(env, offset));
      }
      const recallMatch = p.match(/^\/admin\/messages\/([a-zA-Z0-9-]{1,100})\/recall$/);
      if (recallMatch && method === 'POST') {
        const result = await recallMessage(env, recallMatch[1]);
        return json(result.data, result.status);
      }
      if (p === '/admin/messages' && method === 'POST') {
        const body = await request.json();
        const title = String(body.title || '').trim();
        const message = String(body.body || '').trim();
        if (!title || title.length > 120 || !message || message.length > 10000) return bad('标题 1–120 字，正文 1–10000 字', 422);
        if (body.userId !== null && (!Number.isSafeInteger(body.userId) || body.userId < 1)) return bad('请选择接收账户或全部账户', 422);
        if (body.includeNewUsers !== undefined && typeof body.includeNewUsers !== 'boolean') return bad('新用户选项必须为布尔值', 422);
        if (body.includeNewUsers && body.userId !== null) return bad('新用户可收到消息仅适用于全部账户', 422);
        const result = await sendMessage(env, { target: body.userId, title, body: message, includeNewUsers: body.includeNewUsers === true });
        return json(result.data, result.status);
      }
      return bad('Not Found', 404);
    }

    if (p === '/account/events-ticket' && method === 'POST') {
      const user = await userFromRequest(env.DB, request, true);
      if (!user) return bad('会话已过期', 401);
      const ticket = crypto.randomUUID() + crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM account_tickets WHERE expires_at < ?').bind(Date.now()),
        env.DB.prepare('INSERT INTO account_tickets VALUES (?, ?, ?, ?)').bind(ticket, user.id, Date.now() + 30000, user.expires_at),
      ]);
      return json({ ticket });
    }
    if (p === '/account/events' && method === 'GET') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return bad('WebSocket required', 426);
      const ticket = await env.DB.prepare('DELETE FROM account_tickets WHERE ticket = ? AND expires_at > ? RETURNING user_id, session_expires').bind(url.searchParams.get('ticket') || '', Date.now()).first();
      if (!ticket || ticket.session_expires <= Date.now()) return bad('会话已过期', 401);
      const hub = env.ACCOUNT_EVENTS.get(env.ACCOUNT_EVENTS.idFromName('accounts'));
      return hub.fetch(new Request('https://internal/connect', { headers: {
        Upgrade: 'websocket', 'X-Account-Id': String(ticket.user_id), 'X-Session-Expires': String(ticket.session_expires),
      } }));
    }
    if (p === '/account/messages' && method === 'GET') {
      const user = await userFromRequest(env.DB, request, true);
      if (!user) return bad('会话已过期', 401);
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const { results } = await env.DB.prepare('SELECT id, title, body, created_at, read_at FROM account_messages WHERE user_id = ? AND recalled_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET ?').bind(user.id, offset).all();
      const count = await env.DB.prepare('SELECT count(*) AS total FROM account_messages WHERE user_id = ? AND read_at IS NULL AND recalled_at IS NULL').bind(user.id).first();
      return json({ messages: results.map(message => ({ ...message, source_language: detectMessageLanguage(message) })), unread: count.total, nextOffset: results.length === 50 ? offset + 50 : null });
    }
    if (p === '/account/messages/translate' && method === 'POST') {
      const user = await userFromRequest(env.DB, request, true);
      if (!user) return bad('会话已过期', 401);
      let input;
      try { input = await request.json(); } catch { return json({ code: 'INVALID_REQUEST' }, 400); }
      const result = await translateAccountMessage(env, user.id, input);
      return json(result.data, result.status);
    }
    if (p === '/account/messages/read' && method === 'POST') {
      const user = await userFromRequest(env.DB, request, true);
      if (!user) return bad('会话已过期', 401);
      const body = await request.json();
      const ids = Array.isArray(body.ids) ? body.ids.filter(id => typeof id === 'string').slice(0, 50) : [];
      if (ids.length) await env.DB.prepare(`UPDATE account_messages SET read_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND read_at IS NULL AND recalled_at IS NULL`).bind(new Date().toISOString(), user.id, ...ids).run();
      await publishAccountEvent(env, user.id, { type: 'messages-changed' });
      return json({ ok: true });
    }

    const messageMatch = p.match(/^\/account\/messages\/([a-zA-Z0-9-]{1,100})$/);
    if (messageMatch && method === 'GET') {
      const user = await userFromRequest(env.DB, request, true);
      if (!user) return bad('会话已过期', 401);
      const message = await env.DB.prepare('SELECT id, title, body, created_at, read_at FROM account_messages WHERE id = ? AND user_id = ? AND recalled_at IS NULL').bind(messageMatch[1], user.id).first();
      return message ? json({ ...message, source_language: detectMessageLanguage(message) }) : bad('消息不存在或已撤回', 404);
    }

    if (p === '/polls' || p.startsWith('/polls/')) {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      return handleUserPoll(request, env, url, user);
    }

    // ---------- 安装包直链分发（免登录） ----------
    // 安装包托管在 GitHub Releases（公开仓库资产下载免认证、无 API 速率限制）。
    // /dl/<文件名> → releases/latest/download/<文件名> 回源流式转发：
    // 用户侧走 Cloudflare 边缘，规避国内直连 GitHub 慢的问题；
    // 用 latest 而非固定 tag，App 内更新器永远能拿到最新 latest-mac.yml。
    if (p.startsWith('/dl/')) {
      if (method !== 'GET' && method !== 'HEAD') return bad('仅支持 GET/HEAD', 405);
      let name = '';
      try { name = decodeURIComponent(p.slice(4)); } catch { return bad('文件不存在', 404); }
      if (!/^[\w.-]+\.(dmg|exe|zip|yml|blockmap)$/i.test(name)) return bad('文件不存在', 404);
      const gh = await fetch(
        `https://github.com/CoCodeAgent/CoCode/releases/latest/download/${name}`,
        { method, redirect: 'follow', headers: { 'user-agent': 'cocode-dl' } },
      );
      if (!gh.ok) return bad('文件不存在', 404);
      const headers = {
        'content-type': gh.headers.get('content-type') || 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
        // yml 是自动更新清单，缓存过长会让旧客户端晚一天看到新版本
        'cache-control': /\.yml$/i.test(name) ? 'public, max-age=300' : 'public, max-age=86400',
      };
      const len = gh.headers.get('content-length');
      if (len) headers['content-length'] = len;
      const etag = gh.headers.get('etag');
      if (etag) headers['etag'] = etag;
      return new Response(method === 'HEAD' ? null : gh.body, { status: 200, headers });
    }

    // 免费语音识别保留；旧官方模型网关已下线。
    if (p.startsWith('/asr/v1/')) {
      return handleAsrGateway(env, request, url.pathname.slice('/asr/v1/'.length));
    }
    if (p.startsWith('/official/v1/')) return bad('Not Found', 404);

    // 「登录或注册」第一步：查账号是否已注册。只回 registered 布尔——
    // 不回 email/username，避免用用户名反查邮箱的账号枚举与邮箱泄露。
    if (p === '/auth/check' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const account = String(body.account ?? '').trim();
      if (!account) return bad('请输入用户名或邮箱');
      const user = account.includes('@')
        ? await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(account.toLowerCase()).first()
        : await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(account).first();
      return json({ registered: !!user });
    }

    // 注册第二步：向未注册邮箱发送 6 位验证码
    if (p === '/auth/code' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!isValidEmail(email)) return bad('邮箱格式不正确');
      const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
      if (exists) return bad('该邮箱已注册，请直接登录', 409);
      if (!env.RESEND_API_KEY) return bad('邮件服务未配置（RESEND_API_KEY）', 500);
      const r = await sendVerificationCode(env, email);
      if (!r.ok) return bad(r.detail, r.status);
      return json({ ok: true });
    }

    if (p === '/auth/register' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email ?? '').trim().toLowerCase();
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const code = String(body.code ?? '');
      if (!isValidEmail(email)) return bad('邮箱格式不正确');
      if (!isValidUsername(username)) return bad('用户名需为 2-32 位字母、数字、下划线、连字符或中文');
      if (password.length < 8) return bad('密码至少 8 位');
      if (password.length > 128) return bad('密码过长');
      // 邮箱验证码：校验即消费（一次性，防重放）
      if (!(await consumeVerificationCode(env.DB, email, code))) return bad('验证码错误或已过期');
      const emailTaken = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
      if (emailTaken) return bad('该邮箱已注册，请直接登录', 409);
      const nameTaken = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (nameTaken) return bad('该用户名已被使用', 409);
      const salt = await makeSalt();
      const hash = await hashPassword(password, salt);
      const createdAt = new Date().toISOString();
      try {
        const r = await env.DB.prepare('INSERT INTO users (email, salt, hash, created_at, username) VALUES (?, ?, ?, ?, ?)')
          .bind(email, salt, hash, createdAt, username).run();
        const token = await createSession(env.DB, r.meta.last_row_id);
        // 注册成功后异步发送欢迎邮件（waitUntil 不阻塞响应、失败不影响注册）
        ctx?.waitUntil(sendWelcomeEmail(env, email).catch((e) => console.error(`欢迎邮件异常：${e?.message ?? e}`)));
        return json({ token, email, username, createdAt, avatar: null });
      } catch (e) {
        // 兜底并发：email/username 的 UNIQUE 索引被抢先注册
        return bad('该邮箱或用户名已被使用', 409);
      }
    }

    if (p === '/auth/login' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const account = String(body.account ?? '').trim();
      const password = String(body.password ?? '');
      if (!account) return bad('请输入用户名或邮箱');
      // Turnstile 门禁
      if (!(await verifyTurnstile(env, request, body['cf-turnstile-response'], 'login'))) {
        return bad('人机验证失败，请重试', 403);
      }
      // 限速：账号被锁定则直接拒
      if (await checkLoginLocked(env.DB, account)) {
        return bad('尝试次数过多，请 5 分钟后再试', 429);
      }
      const user = account.includes('@')
        ? await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(account.toLowerCase()).first()
        : await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(account).first();
      // 用户不存在也做一次哈希：拉平时延，避免时序侧信道暴露「账号是否注册」
      const salt = user?.salt ?? 'deadbeefdeadbeefdeadbeefdeadbeef';
      const computed = await hashPassword(password, salt);
      if (!user || !timingSafeEqual(computed, user.hash)) {
        await recordLoginFail(env.DB, account);
        return bad('账号或密码错误', 401);
      }
      await clearLoginFails(env.DB, account);
      const token = await createSession(env.DB, user.id);
      return json({ token, email: user.email, username: user.username, createdAt: user.created_at, avatar: user.avatar ?? null });
    }

    if (p === '/auth/me' && method === 'GET') {
      const user = await userFromRequest(env.DB, request, true);
      if (!user) return bad('未登录或会话已过期', 401);
      return json({ email: user.email, username: user.username, createdAt: user.created_at, avatar: user.avatar ?? null, banned: !!user.banned, banReason: user.ban_reason || '' });
    }

    // ---- 账号管理：改密 / 改邮箱 / 改头像（均需 Bearer token，改密改邮箱需验证当前密码） ----

    if (p === '/auth/password' && method === 'POST') {
      const session = await userFromRequest(env.DB, request);
      if (!session) return bad('未登录或会话已过期', 401);
      const body = await request.json().catch(() => ({}));
      const current = String(body.currentPassword ?? '');
      const next = String(body.newPassword ?? '');
      if (next.length < 8) return bad('密码至少 8 位');
      if (next.length > 128) return bad('密码过长');
      const full = await env.DB.prepare('SELECT salt, hash FROM users WHERE id = ?').bind(session.id).first();
      const computed = await hashPassword(current, full?.salt ?? '');
      if (!full || !timingSafeEqual(computed, full.hash)) return bad('当前密码错误', 403);
      // 换密码必须换盐，避免新旧哈希可关联
      const salt = await makeSalt();
      const hash = await hashPassword(next, salt);
      await env.DB.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').bind(salt, hash, session.id).run();
      // 改密后失效其他设备的会话（保留当前 token，避免把本人踢下线）
      const curToken = (request.headers.get('authorization') ?? '').slice(7).trim();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(session.id, curToken).run();
      return json({ ok: true });
    }

    if (p === '/auth/email' && method === 'POST') {
      const session = await userFromRequest(env.DB, request);
      if (!session) return bad('未登录或会话已过期', 401);
      const body = await request.json().catch(() => ({}));
      const current = String(body.currentPassword ?? '');
      const email = String(body.newEmail ?? '').trim().toLowerCase();
      const code = String(body.code ?? '');
      if (!isValidEmail(email)) return bad('邮箱格式不正确');
      const full = await env.DB.prepare('SELECT salt, hash FROM users WHERE id = ?').bind(session.id).first();
      const computed = await hashPassword(current, full?.salt ?? '');
      if (!full || !timingSafeEqual(computed, full.hash)) return bad('当前密码错误', 403);
      const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(email, session.id).first();
      if (exists) return bad('该邮箱已被使用', 409);
      // 新邮箱必须验证码校验通过（防改成一个自己控制不了或他人占用的邮箱）
      if (!(await consumeVerificationCode(env.DB, email, code))) return bad('验证码错误或已过期');
      await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, session.id).run();
      // 改邮箱后失效其他设备的会话（邮箱已变，其他设备应重新登录）
      const curToken = (request.headers.get('authorization') ?? '').slice(7).trim();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(session.id, curToken).run();
      return json({ ok: true, email });
    }

    if (p === '/auth/avatar' && method === 'POST') {
      const session = await userFromRequest(env.DB, request);
      if (!session) return bad('未登录或会话已过期', 401);
      const body = await request.json().catch(() => ({}));
      const avatar = body.avatar == null ? null : String(body.avatar);
      if (avatar) {
        if (!/^data:image\/(png|jpeg|webp);base64,/.test(avatar)) return bad('头像格式不支持');
        if (avatar.length > 300_000) return bad('头像过大，请换一张小图');
      }
      await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(avatar, session.id).run();
      return json({ ok: true, avatar });
    }

    if (p === '/auth/logout' && method === 'POST') {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true });
    }

    // ---------- 模型列表（云端权威，一账号一列表） ----------
    // 行 → 前端模型条目。apiKey 一并返回（用户自己的数据 + token 鉴权）：
    // 跨设备同步时本地 core 运行时需要 apiKey 明文合成凭证；apiKeySet 供
    // 前端展示「已配置 Key」标记，不回显明文。
    const modelRowToItem = (r) => ({
      id: r.id, provider: r.provider ?? '', label: r.label ?? '', model: r.model,
      baseURL: r.base_url, enabled: !!r.enabled, apiKey: r.api_key ?? '', apiKeySet: !!r.api_key,
      vision: r.vision == null ? null : !!r.vision,
    });

    if (p === '/models' && method === 'GET') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const { results } = await env.DB.prepare(
        "SELECT * FROM user_models WHERE user_id = ? AND id NOT LIKE 'official-%' AND base_url NOT LIKE '%/official/v1%' ORDER BY position ASC, created_at ASC"
      ).bind(user.id).all();
      return json({ models: (results ?? []).map(modelRowToItem) });
    }

    if (p === '/models' && method === 'POST') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const body = await request.json().catch(() => ({}));
      const baseRaw = String(body.baseURL ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(baseRaw)) return bad('baseURL 必须是 http(s) 地址', 422);
      if (isRetiredOfficialModelURL(baseRaw)) return bad('官方模型服务已下线，请配置自定义模型地址', 422);
      const provider = String(body.provider ?? 'custom');
      const label = String(body.label ?? body.provider ?? '自定义');
      const apiKeyRaw = String(body.apiKey ?? '').trim();
      const vision = typeof body.vision === 'boolean' ? (body.vision ? 1 : 0) : null;
      const models = Array.isArray(body.models) && body.models.length
        ? body.models.map((s) => String(s).trim()).filter(Boolean)
        : [String(body.model ?? '').trim()].filter(Boolean);
      if (models.length === 0) return bad('model 不能为空', 422);
      // 同 provider+baseURL 已有条目：apiKey 留空时复用其 key
      const existing = await env.DB.prepare(
        'SELECT id, api_key, vision FROM user_models WHERE user_id = ? AND provider = ? AND base_url = ?'
      ).bind(user.id, provider, baseRaw).all();
      const sibling = (existing.results ?? []).find((x) => x.api_key) ?? null;
      const apiKey = apiKeyRaw || sibling?.api_key || '';
      const effVision = vision ?? (sibling && sibling.vision != null ? sibling.vision : null);
      const now = new Date().toISOString();
      let added = 0, updated = 0;
      for (const model of models) {
        const dup = await env.DB.prepare(
          'SELECT id FROM user_models WHERE user_id = ? AND provider = ? AND lower(model) = lower(?)'
        ).bind(user.id, provider, model).first();
        if (dup) {
          await env.DB.prepare(
            'UPDATE user_models SET base_url = ?, vision = ?, updated_at = ? WHERE id = ?'
          ).bind(baseRaw, effVision, now, dup.id).run();
          if (apiKey) {
            await env.DB.prepare('UPDATE user_models SET api_key = ? WHERE id = ?').bind(apiKey, dup.id).run();
          }
          await env.DB.prepare('UPDATE user_models SET enabled = 1 WHERE id = ?').bind(dup.id).run();
          updated++;
        } else {
          const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          await env.DB.prepare(
            'INSERT INTO user_models (id, user_id, provider, label, model, base_url, api_key, enabled, vision, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)'
          ).bind(id, user.id, provider, label, model, baseRaw, apiKey, effVision, now, now).run();
          added++;
        }
      }
      return json({ status: 'ok', added, updated });
    }

    {
      const m = p.match(/^\/models\/([\w-]+)$/);
      if (m) {
        const user = await userFromRequest(env.DB, request);
        if (!user) return bad('未登录或会话已过期', 401);
        const row = await env.DB.prepare(
          'SELECT id FROM user_models WHERE id = ? AND user_id = ?'
        ).bind(m[1], user.id).first();
        if (!row) return bad('模型不存在', 404);
        if (method === 'PATCH') {
          const body = await request.json().catch(() => ({}));
          if (typeof body.baseURL === 'string' && isRetiredOfficialModelURL(body.baseURL)) {
            return bad('官方模型服务已下线，请配置自定义模型地址', 422);
          }
          const sets = [];
          const binds = [];
          if (typeof body.model === 'string' && body.model.trim()) { sets.push('model = ?'); binds.push(body.model.trim()); }
          if (typeof body.baseURL === 'string' && /^https?:\/\//.test(body.baseURL.trim())) { sets.push('base_url = ?'); binds.push(body.baseURL.trim().replace(/\/+$/, '')); }
          if (typeof body.apiKey === 'string' && body.apiKey.trim()) { sets.push('api_key = ?'); binds.push(body.apiKey.trim()); }
          if (typeof body.label === 'string' && body.label.trim()) { sets.push('label = ?'); binds.push(body.label.trim()); }
          if (typeof body.enabled === 'boolean') { sets.push('enabled = ?'); binds.push(body.enabled ? 1 : 0); }
          if (body.vision === null) { sets.push('vision = NULL'); }
          else if (typeof body.vision === 'boolean') { sets.push('vision = ?'); binds.push(body.vision ? 1 : 0); }
          if (sets.length) {
            sets.push('updated_at = ?'); binds.push(new Date().toISOString());
            await env.DB.prepare(`UPDATE user_models SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, m[1]).run();
          }
          return json({ status: 'ok' });
        }
        if (method === 'DELETE') {
          await env.DB.prepare('DELETE FROM user_models WHERE id = ?').bind(m[1]).run();
          return json({ status: 'ok' });
        }
        return bad('Method Not Allowed', 405);
      }
    }

    // 客户端 IP 归属地（Cloudflare 边缘自动注入 request.cf，无需第三方 IP 库）。
    // 前端据此决定是否展示「中国大陆用户境外传输告知」。
    if (p === '/geo' && method === 'GET') {
      return json({ country: request.cf?.country ?? null });
    }

    if (p === '/health' && method === 'GET') return json({ status: 'ok', service: 'cocode-auth' });

    return bad('Not Found', 404);
}
