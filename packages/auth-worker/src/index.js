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
//   GET  /auth/credits   (Bearer) -> {balance, transactions:[...]}
//   POST /auth/redeem    (Bearer) {orderNo}  -> {ok, credits, balance}  爱发电订单兑换积分
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

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// Cloudflare Workers 免费套餐对 PBKDF2 迭代次数的上限是 100,000，超过会抛
// OperationError（线上表现为 1101）。本地 wrangler dev 无此限制，勿调高。
const PBKDF2_ITERATIONS = 100_000;

// ---------- 工具 ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

const bad = (message, status = 400) => json({ detail: message }, status);

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
    // 积分账户：每用户一行，balance 为当前可用积分。
    db.prepare(`CREATE TABLE IF NOT EXISTS user_credits (
      user_id INTEGER PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`),
    // 积分流水：记录每笔积分变动（兑换/消费/补发），order_no 做幂等去重。
    db.prepare(`CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      order_no TEXT,
      remark TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_order ON credit_transactions(order_no) WHERE order_no IS NOT NULL`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id)`),
    // 订阅周期（月度）：每次成功兑换写一行；用户有效期 = MAX(expire_at)。
    // 续期从 max(now, 当前到期日) 起 +30 天，连续订阅不会损失剩余天数。
    db.prepare(`CREATE TABLE IF NOT EXISTS subscription_grants (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      plan_key TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      order_no TEXT,
      start_at TEXT NOT NULL,
      expire_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sub_user ON subscription_grants(user_id)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_order ON subscription_grants(order_no) WHERE order_no IS NOT NULL`),
    // 积分批次：每笔套餐积分独立一批，随对应订阅周期到期，当月有效不结转。
    // source：subscription=套餐基础积分 / bonus=赠送积分（可配独立有效期）。
    // 扣减顺序（WorkBuddy 式）：expire_at 最早优先；同到期先基础、后赠送。
    db.prepare(`CREATE TABLE IF NOT EXISTS credit_grants (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      plan_key TEXT NOT NULL,
      order_no TEXT,
      amount INTEGER NOT NULL,
      remaining INTEGER NOT NULL,
      granted_at TEXT NOT NULL,
      expire_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'subscription'
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_cg_user_expire ON credit_grants(user_id, expire_at)`),
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
  // 官方模型标记：is_official=1 的行由 /official/models 维护，api_key 永远为空
  // （真实上游密钥只保存在 Worker secret，调用走 /official/v1 网关注入，不下发给客户端）。
  try {
    await db.prepare('ALTER TABLE user_models ADD COLUMN is_official INTEGER NOT NULL DEFAULT 0').run();
  } catch { /* 列已存在 */ }
  // 积分批次来源（WorkBuddy 式扣减优先级）：subscription=基础积分，bonus=赠送积分。
  // 同到期时间先扣基础、再扣赠送；赠送批次可拥有独立于订阅周期的有效期。
  try {
    await db.prepare("ALTER TABLE credit_grants ADD COLUMN source TEXT NOT NULL DEFAULT 'subscription'").run();
  } catch { /* 列已存在 */ }
  await db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)'
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

async function userFromRequest(db, req) {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const row = await db.prepare(
    'SELECT u.id, u.email, u.created_at, u.avatar, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).bind(token).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return row;
}

// ---------- 积分与订阅周期（月度） ----------
//
// 三档订阅与积分对应（与 docs/official-model-subscription.md §3 一致）：
//   Lite ¥39  → 2,000 积分 / 30 天
//   Pro  ¥99  → 6,000 积分 / 30 天
//   Max  ¥299 → 25,000 积分 / 30 天
// 每次成功兑换 = 一个订阅周期：
//   · subscription_grants 写一行；有效期 = max(当前到期日, now) + 30 天
//     （周期内再买，天数顺延不损失）。
//   · credit_grants 写一批积分，expire_at 与本次周期到期日对齐，到期即不可用。
//   · 扣减时只在未过期批次内按 expire_at 升序 FIFO。
// 兑换通过爱发电订单号校验，order_no 唯一索引防重复兑换。

const SUBSCRIPTION_DAYS = 30;

const SUBSCRIPTION_PLANS = [
  { key: 'lite', name: 'CoCode Plan - Lite',  price: 39,  credits: 2000  },
  { key: 'pro',  name: 'CoCode Plan - Pro',   price: 99,  credits: 6000  },
  { key: 'max',  name: 'CoCode Plan - Max',   price: 299, credits: 25000 },
];

/** 按实付金额（元）匹配套餐；未匹配返回 null。 */
function planForAmount(amountYuan) {
  const amt = Number(amountYuan);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  return SUBSCRIPTION_PLANS.find((p) => Math.abs(p.price - amt) < 0.02) ?? null;
}
/** 兼容旧调用名。 */
function creditsForAmount(amountYuan) {
  return planForAmount(amountYuan)?.credits ?? null;
}

const id36 = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

/** 当前可用积分：未过期批次剩余之和（过期批次自动不计）。 */
async function getCredits(db, userId) {
  const row = await db.prepare(
    'SELECT COALESCE(SUM(remaining), 0) AS n FROM credit_grants WHERE user_id = ? AND expire_at > ? AND remaining > 0'
  ).bind(userId, new Date().toISOString()).first();
  return row ? row.n : 0;
}

/**
 * 当前订阅状态：取 expire_at 最大的一笔。
 * @returns {Promise<{active:boolean, planKey:string|null, planName:string|null, expireAt:string|null, daysLeft:number}>}
 */
async function getSubscription(db, userId) {
  const row = await db.prepare(
    'SELECT plan_key, plan_name, expire_at FROM subscription_grants WHERE user_id = ? ORDER BY expire_at DESC LIMIT 1'
  ).bind(userId).first();
  const none = { active: false, planKey: null, planName: null, expireAt: null, daysLeft: 0 };
  if (!row) return none;
  const now = Date.now();
  const expireMs = new Date(row.expire_at).getTime();
  const daysLeft = Math.max(0, Math.ceil((expireMs - now) / 86_400_000));
  return {
    active: expireMs > now,
    planKey: row.plan_key,
    planName: row.plan_name,
    expireAt: row.expire_at,
    daysLeft,
  };
}

/** 是否在订阅有效期内（网关准入用）。 */
async function hasSubscription(db, userId) {
  return (await getSubscription(db, userId)).active;
}

/**
 * 开通/续期一个月度周期并发放积分批次（同事务 + 流水）。
 * 续期基线 = max(now, 现有到期日)，周期内复购不顺延起点之外的任何额外规则。
 * @returns {Promise<{balance:number, expireAt:string, startAt:string}>}
 */
async function grantSubscription(db, userId, plan, orderNo, remark) {
  const now = new Date();
  const nowIso = now.toISOString();
  const cur = await getSubscription(db, userId);
  // 周期内续费：从现有到期日继续顺延；已过期/首次：从现在起算
  const baseMs = cur.active && cur.expireAt ? new Date(cur.expireAt).getTime() : now.getTime();
  const startIso = new Date(baseMs).toISOString();
  const expireIso = new Date(baseMs + SUBSCRIPTION_DAYS * 86_400_000).toISOString();

  await db.batch([
    db.prepare(
      'INSERT INTO subscription_grants (id, user_id, plan_key, plan_name, order_no, start_at, expire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`sg-${id36()}`, userId, plan.key, plan.name, orderNo ?? null, startIso, expireIso, nowIso),
    db.prepare(
      'INSERT INTO credit_grants (id, user_id, plan_key, order_no, amount, remaining, granted_at, expire_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`cg-${id36()}`, userId, plan.key, orderNo ?? null, plan.credits, plan.credits, nowIso, expireIso, 'subscription'),
    db.prepare(
      'INSERT INTO credit_transactions (user_id, amount, type, order_no, remark, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(userId, plan.credits, 'redeem', orderNo ?? null, remark ?? null, nowIso),
  ]);
  return { balance: await getCredits(db, userId), expireAt: expireIso, startAt: startIso };
}

/**
 * 在未过期批次内扣减积分（WorkBuddy 式优先级）：
 * 先消耗最早到期的批次；到期时间相同，先基础（subscription）、再赠送（bonus）。
 * @returns {Promise<number>} 实际扣到的积分（≤ amount；余额不足时小于 amount）
 */
async function consumeFromBatches(db, userId, amount) {
  const nowIso = new Date().toISOString();
  const { results } = await db.prepare(
    `SELECT id, remaining FROM credit_grants
     WHERE user_id = ? AND remaining > 0 AND expire_at > ?
     ORDER BY expire_at ASC,
              CASE COALESCE(source, 'subscription') WHEN 'subscription' THEN 0 ELSE 1 END ASC,
              granted_at ASC, id ASC`
  ).bind(userId, nowIso).all();
  let need = Math.max(0, Math.floor(Number(amount) || 0));
  const stmts = [];
  for (const g of results ?? []) {
    if (need <= 0) break;
    const take = Math.min(g.remaining, need);
    stmts.push(db.prepare('UPDATE credit_grants SET remaining = remaining - ? WHERE id = ?').bind(take, g.id));
    need -= take;
  }
  if (stmts.length) await db.batch(stmts);
  return amount - need;
}

/**
 * 调用爱发电开放平台「查询订单」接口，校验订单号对应的支付状态与金额。
 * 文档：https://afdian.com/p/api  端点：https://ifdian.net/api/open/query-order
 * 需要环境变量 AFD_USER_ID（用户 id）与 AFD_TOKEN（API token）。
 * 返回 { ok, amount, planName, error }。
 */
async function queryAfadianOrder(env, orderNo) {
  const userId = env.AFD_USER_ID;
  const token = env.AFD_TOKEN;
  if (!userId || !token) {
    return { ok: false, error: '服务端未配置爱发电 API 凭证，请联系管理员' };
  }
  // 爱发电开放平台接口规范：
  //   POST https://ifdian.net/api/open/query-order
  //   表单字段：user_id, ts(秒级时间戳), params(JSON 字符串，不能为空对象), sign
  //   签名：md5(token + "params" + params值 + "ts" + ts值 + "user_id" + user_id值)
  //   返回：{ ec:200, em:"order", data:{ list:[{out_trade_no,total_amount,status,plan_title,...}], total_count } }
  const ts = Math.floor(Date.now() / 1000);
  const paramsJson = JSON.stringify({ out_trade_no: orderNo });
  const kvString = 'params' + paramsJson + 'ts' + ts + 'user_id' + userId;
  const sign = md5Hex(token + kvString);
  const body = new URLSearchParams({ user_id: userId, ts, params: paramsJson, sign });
  let resp;
  try {
    resp = await fetch('https://ifdian.net/api/open/query-order', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: '爱发电接口请求超时，请稍后重试' };
  }
  if (!resp.ok) return { ok: false, error: `爱发电接口错误 HTTP ${resp.status}` };
  const data = await resp.json().catch(() => null);
  if (!data || data.ec !== 200) {
    return { ok: false, error: data?.em || '订单查询失败，请确认订单号是否正确' };
  }
  const order = data?.data?.list?.[0];
  if (!order) return { ok: false, error: '未找到该订单，请确认订单号是否正确' };
  // status: 2 = 已支付（爱发电订单状态码）
  if (Number(order.status) !== 2) {
    return { ok: false, error: '该订单尚未支付完成，请支付后再兑换' };
  }
  const amount = Number(order.total_amount ?? order.show_amount ?? 0);
  return { ok: true, amount, planName: order.plan_title || order.title || '' };
}

/** 轻量 MD5（WebCrypto 不支持 MD5，用纯实现；只用于爱发电签名，不涉及安全）。 */
function md5Hex(s) {
  function rhex(n) { let h = ''; for (let j = 0; j < 4; j++) h += ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16); return h; }
  function ad(x, y) { const l = (x & 0xffff) + (y & 0xffff); const m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xffff); }
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cm(q, a, b, x, s, t) { return ad(rl(ad(ad(a, q), ad(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cm((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cm((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cm(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cm(c ^ (b | ~d), a, b, x, s, t); }
  function cb(x) { let i; const nblk = ((x.length + 8) >> 6) + 1; const blks = new Array(nblk * 16); for (i = 0; i < nblk * 16; i++) blks[i] = 0; for (i = 0; i < x.length; i++) blks[i >> 2] |= x.charCodeAt(i) << ((i % 4) * 8); blks[i >> 2] |= 0x80 << ((i % 4) * 8); blks[(nblk * 16) - 2] = x.length * 8; return blks; }
  const x = cb(s); let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i + 0], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586); c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426); c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417); c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101); c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632); c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i + 0], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083); c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690); c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784); c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463); c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353); c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i + 0], 11, -358537222); c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835); c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i + 0], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415); c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606); c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744); c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379); c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = ad(a, oa); b = ad(b, ob); c = ad(c, oc); d = ad(d, od);
  }
  return rhex(a) + rhex(b) + rhex(c) + rhex(d);
}

// ---------- 套餐（Coding Plan / Token Plan / Agent Plan）目录 ----------
// 与 packages/core/src/plans.js 的 PLAN_DEFS 保持一致（静态数据，改动需两边同步）。
const PLAN_DEFS = [
  { key: 'glm-coding', name: '智谱 GLM Coding Plan', vendor: '智谱 AI', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', buyUrl: 'https://www.bigmodel.cn/glm-coding', note: '每月固定费用畅用 GLM 系列编程模型，按 5 小时周期刷新额度。', models: ['glm-4.7', 'glm-4.5-air'] },
  { key: 'zai-coding', name: 'Z.ai GLM Coding Plan（国际版）', vendor: 'Z.ai', baseURL: 'https://api.z.ai/api/coding/paas/v4', keyUrl: 'https://z.ai/manage-apikey/apikey-list', buyUrl: 'https://z.ai/subscription', note: '国际版 GLM 套餐，模型与国内版一致，支持国际支付方式。', models: ['glm-4.7', 'glm-4.5-air'] },
  { key: 'minimax-coding', name: 'MiniMax Token Plan', vendor: 'MiniMax', baseURL: 'https://api.minimaxi.com/v1', keyUrl: 'https://platform.minimaxi.com', buyUrl: 'https://platform.minimax.io/subscribe/coding-plan', note: '统一 Token 套餐，编码与智能体场景共用额度，畅用 MiniMax 旗舰模型，按 5 小时周期刷新。', models: ['MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M2.1'] },
  { key: 'ark-coding', name: '字节 · 方舟 Coding Plan', vendor: '火山引擎', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', keyUrl: 'https://console.volcengine.com/ark', buyUrl: 'https://www.volcengine.com/activity/codingplan', note: '一个套餐可用豆包、DeepSeek、Kimi 等多款编程模型，额度每月刷新。', models: ['doubao-seed-2.0-code', 'doubao-seed-2.1-turbo', 'kimi-k2.7-code', 'deepseek-v4-pro', 'minimax-m3'] },
  { key: 'ark-agent', name: '字节 · 方舟 Agent Plan', vendor: '火山引擎', baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3', keyUrl: 'https://ark.volcengine.com/region:cn-beijing/openManagement?LLM=%7B%7D&OpenModelVisible=false&advancedActiveKey=agentPlan', buyUrl: 'https://www.volcengine.com/activity/agentplan', note: '面向智能体场景的独立套餐，以「智能体燃料 AFP」统一计量，可用豆包、GLM、DeepSeek、Kimi、MiniMax 等多款模型，40 元/月起。需使用 Agent Plan 专属 API Key，与 Coding Plan / 按量 Key 均不通用。', models: ['doubao-seed-2.1-turbo', 'doubao-seed-evolving', 'deepseek-v4-pro', 'kimi-k3', 'minimax-m3', 'ark-code-latest', 'glm-5.3-flash', 'glm-latest', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'doubao-seed-2.0-lite', 'doubao-seed-2.0-mini', 'kimi-k2.7-code'] },
  { key: 'mimo-plan', name: '小米 MiMo Token Plan', vendor: '小米', baseURL: 'https://api.xiaomimimo.com/v1', keyUrl: 'https://www.xiaomimimo.com', buyUrl: 'https://www.xiaomimimo.com', note: '订阅后畅用小米 MiMo 系列模型，按 token 计量额度。', models: ['mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-flash'] },
  { key: 'tencent-plan', name: '腾讯 TokenHub Token Plan', vendor: '腾讯云', baseURL: 'https://api.lkeap.cloud.tencent.com/coding/v3', keyUrl: 'https://console.cloud.tencent.com/lkeap', buyUrl: 'https://console.cloud.tencent.com/lkeap', note: '已升级为统一 Token 套餐，编码与智能体场景共用额度，畅用腾讯混元模型。', models: ['tc-code-latest', 'hunyuan-turbo'] },
  { key: 'qwen-coding', name: '阿里云百炼 Token Plan（Qwen）', vendor: '阿里云', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1', buyUrl: 'https://www.aliyun.com/benefit-list/ai-programming', note: '统一 Token 套餐，编码与智能体场景共用额度，除通义千问外还覆盖 Kimi、GLM 等第三方模型。', models: ['qwen3.6-plus', 'qwen3-coder-plus', 'qwen3-coder-flash'] },
];
const planDef = (key) => PLAN_DEFS.find((p) => p.key === key) ?? null;

// ---------- 模型积分消耗倍率 ----------
// 纯计算逻辑抽到 src/credits.js（测试共用同一模块），
// 倍率与档位规则必须与 packages/core/src/credit-rates.js 保持同步。
import { MODEL_TIERS, MODE_RATES, ASR_RATE_PER_SECOND, resolveTier, calcCredits, calcAsrCredits } from './credits.js';

/** 严格扣减（上报端点用）：未过期批次余额不足返回 null，不产生任何扣减。 */
async function deductCredits(db, userId, amount, type, remark) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (amt <= 0) return null;
  const balance = await getCredits(db, userId);
  if (balance < amt) return null;
  const consumed = await consumeFromBatches(db, userId, amt);
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO credit_transactions (user_id, amount, type, order_no, remark, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(userId, -consumed, type, null, remark ?? null, now).run();
  return getCredits(db, userId);
}

/**
 * 计费扣减（网关用）：允许单次透支——调用前无法精确知道 token 数，
 * 把未过期批次扣到 0 并记全额流水（含透支额），下次调用因余额为 0 被拦下。
 */
async function billCredits(db, userId, amount, type, remark) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (amt <= 0) return { billed: 0, balance: await getCredits(db, userId), overdraft: false };
  const balance = await getCredits(db, userId);
  const consumed = await consumeFromBatches(db, userId, amt);
  const now = new Date().toISOString();
  await db.prepare(
    'INSERT INTO credit_transactions (user_id, amount, type, order_no, remark, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(userId, -amt, type, null, remark ?? null, now).run();
  const next = await getCredits(db, userId);
  return { billed: amt, consumed, balance: next, overdraft: amt > consumed };
}

/**
 * 网关计费错误：顶层 message 供 core model.js（data.message）解析，
 * detail.message 供桌面语音 voice.js 解析，code 供前端区分引导。
 */
function paywall(status, message, code) {
  return json({ message, code, detail: { message, code } }, status);
}

// ---------- 官方模型目录与计费网关 ----------
//
// 官方模型 = CoCode 托管上游密钥的模型，用户不需要自己注册供应商/填 Key。
// 数据面：客户端（core）拿到的 modelList 条目 baseURL 指向本网关
//   /official/v1，apiKey 由前端在同步时替换为用户登录 token；
// 网关用 token 鉴权 → 注入 Worker secret 里的真实上游 Key → 转发 →
// 按响应 usage 扣 D1 积分。自定义模型（BYOK/第三方套餐）从不经过网关，
// 因此完全不受积分影响。
//
// 需要的 secret（wrangler secret put）：
//   ZHIPU_API_KEY    智谱 open.bigmodel.cn（GLM 全系 + GLM-ASR）
//   DEEPSEEK_API_KEY DeepSeek api.deepseek.com
// 未配置对应 secret 时，该家模型的网关请求返回 503（不影响其它功能）。

/** 官方模型目录：model 必须与上游真实模型名一致；档位倍率由 MODEL_TIER_RULES 按模型名解析。 */
const OFFICIAL_CATALOG = [
  { model: 'glm-5.3-flash',     provider: 'bigmodel', label: 'GLM-5.3-Flash（官方）' },
  { model: 'deepseek-flash',    provider: 'deepseek', label: 'DeepSeek-Flash（官方）' },
];

const OFFICIAL_UPSTREAMS = {
  bigmodel: { secret: 'ZHIPU_API_KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  deepseek: { secret: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
};

/** 官方条目在 user_models 里的固定 id（幂等 upsert 靠它）。id 含用户维度——表主键是全局唯一 id。 */
const officialRowId = (userId, model) => `official-u${userId}-${model}`;

/**
 * 确保当前用户的官方模型行已落库（幂等），返回与 /models 同构的条目列表。
 * 行内 api_key 恒为空——真实密钥绝不下发。
 */
async function ensureOfficialModels(env, user, gatewayBase) {
  const now = new Date().toISOString();
  // 先清掉历史发放、现已下架的官方模型行（含旧版无用户维度的 id），保证列表只含在售目录。
  const keepIds = OFFICIAL_CATALOG.map((m) => officialRowId(user.id, m.model));
  await env.DB.prepare(
    `DELETE FROM user_models WHERE user_id = ? AND is_official = 1 AND id NOT IN (${keepIds.map(() => '?').join(', ')})`
  ).bind(user.id, ...keepIds).run();
  for (const item of OFFICIAL_CATALOG) {
    const rowId = officialRowId(user.id, item.model);
    const existing = await env.DB.prepare(
      'SELECT id FROM user_models WHERE id = ? AND user_id = ?'
    ).bind(rowId, user.id).first();
    if (existing) {
      // 已存在：只刷新展示信息，绝不动 enabled（用户可以自行停用某款官方模型）。
      // provider 必须写真实服务商 key（bigmodel/deepseek），前端靠它渲染品牌头像。
      await env.DB.prepare(
        'UPDATE user_models SET provider = ?, label = ?, model = ?, base_url = ?, api_key = ?, is_official = 1, updated_at = ? WHERE id = ?'
      ).bind(item.provider, item.label, item.model, gatewayBase, '', now, rowId).run();
    } else {
      await env.DB.prepare(
        'INSERT INTO user_models (id, user_id, provider, label, model, base_url, api_key, enabled, vision, position, is_official, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 99, 1, ?, ?)'
      ).bind(rowId, user.id, item.provider, item.label, item.model, gatewayBase, '', now, now).run();
    }
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM user_models WHERE user_id = ? AND is_official = 1 ORDER BY position ASC, created_at ASC'
  ).bind(user.id).all();
  return (results ?? []).map((r) => ({
    id: r.id, provider: r.provider ?? 'official', label: r.label ?? '', model: r.model,
    baseURL: r.base_url, enabled: !!r.enabled, apiKey: '', apiKeySet: false,
    vision: r.vision == null ? null : !!r.vision, isOfficial: true,
    tier: resolveTier(r.model),
  }));
}

/** 网关入口：pathSuffix 形如 chat/completions（baseURL 为 /official/v1）。 */
async function handleOfficialGateway(env, request, pathSuffix) {
  const user = await userFromRequest(env.DB, request);
  if (!user) return json({ detail: { message: '未登录或会话已过期' } }, 401);

  const isAsr = pathSuffix.includes('audio/transcriptions');
  // 任务模式（WorkBuddy 式 Ask/Craft 差异化计费）：客户端经 X-CoCode-Mode 头声明，
  // 取值 ask | craft，缺省 craft（Agent 编码为主场景）；ASR 语音识别不受模式影响。
  const mode = isAsr ? 'craft' : (String(request.headers.get('x-cocode-mode') || '').toLowerCase() || 'craft');

  // 1) 解析目标模型与上游。Workers 的 Request 不可挂自定义字段，
  //    从请求体克隆里读 model；ASR 固定走智谱 GLM-ASR。
  let model = '';
  if (isAsr) {
    model = 'glm-asr-2512';
  } else {
    const meta = await request.clone().json().catch(() => null);
    model = String(meta?.model ?? '');
  }
  const catalog = isAsr ? { model, provider: 'bigmodel' } : OFFICIAL_CATALOG.find((m) => m.model === model);
  const up = catalog ? OFFICIAL_UPSTREAMS[catalog.provider] : null;
  if (!catalog || !up) return json({ detail: { message: `不支持的官方模型：${model || '(未指定)'}` } }, 404);
  const upstreamKey = env[up.secret];
  if (!upstreamKey) return json({ detail: { message: '该官方模型暂未开放（服务端未配置上游密钥）' } }, 503);

  // 2) 订阅门禁（最高优先级）：全部官方模型（各档位文本模型 + 语音识别）
  //    均为订阅专享，且订阅按月度有效期管理。
  //    从未订阅 → SUBSCRIPTION_REQUIRED；曾订阅但已到期 → SUBSCRIPTION_EXPIRED。
  //    自定义模型不走本网关，不受此限制。
  const sub = await getSubscription(env.DB, user.id);
  if (!sub.planKey) {
    return paywall(402, '官方模型为订阅专享，请先在「订阅」页开通套餐后再使用', 'SUBSCRIPTION_REQUIRED');
  }
  if (!sub.active) {
    return paywall(402, '订阅已到期，续费后即可继续使用官方模型', 'SUBSCRIPTION_EXPIRED');
  }
  // 3) 文本模型积分门禁：语音识别不卡余额；免费档零倍率不产生消耗，同样放行。
  //    其余档位实际费用按用量结算，允许一次透支，透支到 0 后下次被这里拦下。
  if (!isAsr && resolveTier(model) !== 'free') {
    const balance = await getCredits(env.DB, user.id);
    if (balance < 1) {
      return paywall(402, '本月积分已用完，请在「订阅」页续费或再次兑换后使用该模型', 'INSUFFICIENT_CREDITS');
    }
  }

  // 2.5) ASR：必须在转发上游之前解析 multipart 时长。request.body 流一旦被
  //      fetch 转发消费，request.clone() 会因 body 已使用而抛 TypeError——
  //      旧实现把解析放在转发之后，错误被静默吞掉，导致语音识别从不扣积分。
  //      此处用 clone 解析（原 body 保持未动，随后仍可完整转发）。
  let asrSeconds = 0;
  if (isAsr) {
    try {
      const form = await request.clone().formData();
      const file = form.get('file');
      if (file instanceof Blob) asrSeconds = wavDurationSeconds(await file.arrayBuffer());
      else console.warn('[asr-billing] multipart 中未找到 file 字段，本次按 0 秒计');
    } catch (e) {
      console.warn('[asr-billing] multipart 解析失败，本次按 0 秒计：', String(e?.message || e));
    }
  }

  const upstreamURL = `${up.baseURL}/${pathSuffix.replace(/^\/+/, '')}`;
  const fwdHeaders = new Headers();
  fwdHeaders.set('authorization', `Bearer ${upstreamKey}`);
  const ct = request.headers.get('content-type');
  if (ct) fwdHeaders.set('content-type', ct);
  const accept = request.headers.get('accept');
  if (accept) fwdHeaders.set('accept', accept);

  const upstream = await fetch(upstreamURL, {
    method: request.method,
    headers: fwdHeaders,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    signal: AbortSignal.timeout(180_000),
  });

  // 上游错误原样透传，不计费
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
    });
  }

  // 3) 语音识别（multipart）：上游成功后，按转发前已解析出的 WAV 时长计费
  if (isAsr) {
    if (asrSeconds > 0) {
      const credits = calcAsrCredits(asrSeconds);
      if (credits > 0) {
        try {
          await billCredits(env.DB, user.id, credits, 'consume', `语音识别 ${Math.round(asrSeconds)}s`);
        } catch (e) {
          console.warn('[asr-billing] 扣费落账失败：', String(e?.message || e));
        }
      }
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
    });
  }

  // 4) Chat：非流式直接读 JSON 计费
  const isStream = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  if (!isStream) {
    const data = await upstream.json().catch(() => null);
    const usage = data?.usage || null;
    if (usage) {
      const credits = calcCredits(model, usage, mode);
      if (credits > 0) await billCredits(env.DB, user.id, credits, 'consume', `官方模型 ${model} · ${mode === 'ask' ? '问答' : '任务'}`).catch(() => {});
    }
    return json(data, upstream.status);
  }

  // 5) Chat：流式 —— 边转发边扫描 SSE 末尾的 usage 帧，流结束时落账
  let tail = '';
  let foundUsage = null;
  const decoder = new TextDecoder();
  const db = env.DB, userId = user.id;
  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      tail += decoder.decode(chunk, { stream: true });
      if (tail.length > 65536) tail = tail.slice(-65536);
      for (const line of tail.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.usage) foundUsage = j.usage;
        } catch { /* 非完整帧，忽略 */ }
      }
    },
    async flush() {
      if (foundUsage) {
        const credits = calcCredits(model, foundUsage, mode);
        if (credits > 0) await billCredits(db, userId, credits, 'consume', `官方模型 ${model} · ${mode === 'ask' ? '问答' : '任务'}`).catch(() => {});
      }
    },
  });
  upstream.body.pipeTo(writable).catch(() => {});
  return new Response(readable, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

/**
 * 从 16kHz/16bit 单声道 WAV（voice.js encodeWav 产物）估算时长（秒）。
 * data 区字节数 / 32000（16000 采样率 × 2 字节）。非 WAV 返回 0。
 */
function wavDurationSeconds(buf) {
  try {
    const b = new Uint8Array(buf);
    if (b.length < 44 || b[0] !== 0x52 || b[1] !== 0x49) return 0; // 'RI'
    const view = new DataView(buf);
    const dataLen = view.getUint32(40, true);
    const bytes = dataLen > 0 && dataLen <= b.length - 44 ? dataLen : Math.max(0, b.length - 44);
    return Math.max(0, bytes / 32000);
  } catch { return 0; }
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

    // ---------- 官方模型计费网关（数据面） ----------
    // core 拿到的官方条目 baseURL 指向 /official/v1；此处鉴权 + 注入上游
    // Key + 转发 + 按 usage 扣积分。BYOK 模型永远不经过这里。
    if (p.startsWith('/official/v1/')) {
      const suffix = url.pathname.slice('/official/v1/'.length);
      return handleOfficialGateway(env, request, suffix);
    }

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
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const credits = await getCredits(env.DB, user.id);
      return json({ email: user.email, username: user.username, createdAt: user.created_at, avatar: user.avatar ?? null, credits });
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

    // ---------- 积分 / 订阅兑换 ----------

    // GET /auth/credits → { balance, subscription, transactions: [...] }
    // subscription 为月度订阅状态（最近一个周期的套餐 + 到期日），前端展示用。
    if (p === '/auth/credits' && method === 'GET') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const balance = await getCredits(env.DB, user.id);
      const subscription = await getSubscription(env.DB, user.id);
      const { results } = await env.DB.prepare(
        'SELECT amount, type, order_no, remark, created_at FROM credit_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50'
      ).bind(user.id).all();
      return json({ balance, subscription, transactions: results ?? [] });
    }

    // POST /auth/redeem { orderNo } → { ok, credits, balance, subscription }
    // 校验爱发电订单 → 开通/续期 30 天订阅 + 发一批当月积分 → 写流水
    // （order_no 唯一防重复兑换；重复兑换为幂等返回，不再发放）
    if (p === '/auth/redeem' && method === 'POST') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const body = await request.json().catch(() => ({}));
      const orderNo = String(body.orderNo ?? '').trim();
      if (!orderNo) return bad('订单号不能为空', 422);

      // 先查重：同订单号已兑换过则直接返回，避免重复发放
      const dup = await env.DB.prepare(
        'SELECT amount FROM credit_transactions WHERE order_no = ?'
      ).bind(orderNo).first();
      if (dup) {
        const [balance, subscription] = await Promise.all([
          getCredits(env.DB, user.id),
          getSubscription(env.DB, user.id),
        ]);
        return json({ ok: true, credits: dup.amount, balance, subscription, alreadyRedeemed: true });
      }

      // 调爱发电查单
      const order = await queryAfadianOrder(env, orderNo);
      if (!order.ok) return bad(order.error, 422);

      const plan = planForAmount(order.amount);
      if (!plan) return bad(`订单金额 ¥${order.amount} 不在订阅套餐范围内（¥39/¥99/¥299）`, 422);

      const res = await grantSubscription(
        env.DB, user.id, plan, orderNo, `爱发电订单 ${orderNo} ${order.planName || ''}`.trim()
      );
      return json({
        ok: true,
        credits: plan.credits,
        balance: res.balance,
        subscription: await getSubscription(env.DB, user.id),
        expireAt: res.expireAt,
      });
    }

    // POST /auth/consume-credits { model, usage, asrSeconds? }
    // 官方模型调用后上报 token 用量 → 按倍率扣减积分 → 返回新余额。
    // 订阅不在有效期或积分不足返回 402，前端据此引导续费/兑换。
    if (p === '/auth/consume-credits' && method === 'POST') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const sub = await getSubscription(env.DB, user.id);
      if (!sub.planKey) return bad('官方模型为订阅专享，请先开通套餐', 402);
      if (!sub.active) return bad('订阅已到期，续费后可继续使用官方模型', 402);
      const body = await request.json().catch(() => ({}));
      const model = String(body.model ?? '');
      const usage = body.usage && typeof body.usage === 'object' ? body.usage : null;
      const asrSeconds = body.asrSeconds;

      let credits = 0;
      if (usage) {
        if (!model) return bad('model 不能为空', 422);
        credits = calcCredits(model, usage);
      }
      if (asrSeconds != null) {
        credits += calcAsrCredits(asrSeconds);
      }
      if (credits <= 0) {
        const balance = await getCredits(env.DB, user.id);
        return json({ ok: true, credits: 0, balance });
      }

      const balance = await deductCredits(env.DB, user.id, credits, 'consume',
        usage ? `模型 ${model} ${usage.prompt_tokens || 0}+${usage.completion_tokens || 0} tokens` : `语音识别 ${asrSeconds}s`);
      if (balance === null) {
        const cur = await getCredits(env.DB, user.id);
        return bad(`积分不足：需要 ${credits}，当前 ${cur}`, 402);
      }
      return json({ ok: true, credits, balance });
    }

    // GET /auth/credit-rates → 模型档位倍率表 + 任务模式倍率（前端展示"约 X 积分/次"）
    if (p === '/auth/credit-rates' && method === 'GET') {
      const tiers = Object.entries(MODEL_TIERS).map(([key, v]) => ({ tier: key, rate: v.rate }));
      return json({ tiers, modes: MODE_RATES, asrRatePerSecond: ASR_RATE_PER_SECOND, anchor: '1 积分 ≈ ¥0.0085 模型成本' });
    }

    // ---------- 模型列表（云端权威，一账号一列表） ----------
    // 行 → 前端模型条目。apiKey 一并返回（用户自己的数据 + token 鉴权）：
    // 跨设备同步时本地 core 运行时需要 apiKey 明文合成凭证；apiKeySet 供
    // 前端展示「已配置 Key」标记，不回显明文。
    const modelRowToItem = (r) => ({
      id: r.id, provider: r.provider ?? '', label: r.label ?? '', model: r.model,
      baseURL: r.base_url, enabled: !!r.enabled, apiKey: r.api_key ?? '', apiKeySet: !!r.api_key,
      vision: r.vision == null ? null : !!r.vision,
      isOfficial: !!r.is_official,
    });

    // GET /official/models → 幂等发放官方模型行（GLM-5.3-Flash + DeepSeek-Flash），
    // 返回的条目 baseURL 指向本网关、apiKey 恒空（客户端同步时用登录 token 填充）。
    if (p === '/official/models' && method === 'GET') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const models = await ensureOfficialModels(env, user, `${url.origin}/official/v1`);
      return json({ models });
    }

    if (p === '/models' && method === 'GET') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const url = new URL(request.url);
      const includeOfficial = url.searchParams.get('includeOfficial') === '1';
      const sql = includeOfficial
        ? 'SELECT * FROM user_models WHERE user_id = ? ORDER BY is_official DESC, position ASC, created_at ASC'
        : 'SELECT * FROM user_models WHERE user_id = ? AND is_official = 0 ORDER BY position ASC, created_at ASC';
      const { results } = await env.DB.prepare(sql).bind(user.id).all();
      return json({ models: (results ?? []).map(modelRowToItem) });
    }

    if (p === '/models' && method === 'POST') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const body = await request.json().catch(() => ({}));
      const baseRaw = String(body.baseURL ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(baseRaw)) return bad('baseURL 必须是 http(s) 地址', 422);
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

    // ---------- 套餐（Coding Plan）接入/断开 ----------
    // 与模型列表一致存云端（user_models），套餐 Key 即 api_key。
    if (p === '/plans' && method === 'GET') {
      const user = await userFromRequest(env.DB, request);
      if (!user) return bad('未登录或会话已过期', 401);
      const { results } = await env.DB.prepare(
        'SELECT base_url, api_key FROM user_models WHERE user_id = ?'
      ).bind(user.id).all();
      const rows = results ?? [];
      const plans = PLAN_DEFS.map((def) => ({
        key: def.key, name: def.name, vendor: def.vendor, note: def.note,
        models: def.models, keyUrl: def.keyUrl, buyUrl: def.buyUrl,
        connected: rows.some((x) => x.base_url === def.baseURL && x.api_key),
      }));
      return json({ plans });
    }

    {
      const m = p.match(/^\/plans\/([\w-]+)\/connect$/);
      if (m) {
        const user = await userFromRequest(env.DB, request);
        if (!user) return bad('未登录或会话已过期', 401);
        const def = planDef(m[1]);
        if (!def) return bad('套餐不存在', 404);
        if (method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const apiKey = String(body.apiKey ?? '').trim();
          if (!apiKey) return bad('apiKey 不能为空', 422);
          const now = new Date().toISOString();
          let added = 0, updated = 0;
          for (const model of def.models) {
            const dup = await env.DB.prepare(
              'SELECT id FROM user_models WHERE user_id = ? AND base_url = ? AND lower(model) = lower(?)'
            ).bind(user.id, def.baseURL, model).first();
            if (dup) {
              await env.DB.prepare(
                'UPDATE user_models SET api_key = ?, enabled = 1, updated_at = ? WHERE id = ?'
              ).bind(apiKey, now, dup.id).run();
              updated++;
            } else {
              const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
              await env.DB.prepare(
                'INSERT INTO user_models (id, user_id, provider, label, model, base_url, api_key, enabled, vision, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, ?, ?)'
              ).bind(id, user.id, def.key, def.name, model, def.baseURL, apiKey, now, now).run();
              added++;
            }
          }
          return json({ status: 'ok', added, updated });
        }
        if (method === 'DELETE') {
          const { meta } = await env.DB.prepare(
            'DELETE FROM user_models WHERE user_id = ? AND base_url = ?'
          ).bind(user.id, def.baseURL).run();
          return json({ status: 'ok', removed: meta.changes ?? 0 });
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
