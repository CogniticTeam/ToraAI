// ChatGPT device authorization, local-only credentials and the Codex model catalog.
// Protocol reference: cc-switch b184a88c; never read or modify the Codex CLI login.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { TORA_DIR } from './config.js';
import { modelFetch } from './model-transport.js';

import { CODEX_PROVIDER, CODEX_BASE_URL, CODEX_CLIENT_VERSION } from './codex-protocol.js';
export { CODEX_PROVIDER, CODEX_CREDENTIAL_ID, CODEX_BASE_URL, CODEX_CLIENT_VERSION } from './codex-protocol.js';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_URL = 'https://auth.openai.com';
const FILE = join(TORA_DIR, 'codex-auth.json');
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
let storage = null, loaded = false, account = null, catalog = [], selected = [];
let pending = null, generation = 0, loginSequence = 0, refreshPromise = null;
let catalogPromise = null, catalogChecked = false;

export function codexError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
const expired = () => codexError('CODEX_LOGIN_EXPIRED', 'Codex 授权已取消或过期，请重新登录');
const reauth = () => codexError('CODEX_REAUTH_REQUIRED', 'Codex 连接已失效，请在添加模型页面重新登录', 401);

/** Electron supplies OS encryption; standalone/testing runtimes keep secrets in memory. */
export function setCodexStorage(value) {
  if (value && (typeof value.encrypt !== 'function' || typeof value.decrypt !== 'function')) throw new TypeError('Invalid Codex secret storage');
  storage = value; loaded = false; account = null; catalog = []; selected = [];
  generation++; loginSequence++; pending = null; refreshPromise = null;
  catalogPromise = null; catalogChecked = false;
}
function load() {
  if (loaded) return;
  loaded = true;
  if (!storage) return;
  try {
    const sealed = JSON.parse(readFileSync(FILE, 'utf8'));
    if (sealed.version !== 1 || typeof sealed.payload !== 'string') return;
    const saved = JSON.parse(storage.decrypt(sealed.payload));
    if (!saved.account?.accessToken || !saved.account?.refreshToken || !saved.account?.accountId || !saved.account?.connectionId) return;
    account = saved.account;
    catalog = Array.isArray(saved.catalog) ? saved.catalog : [];
    selected = Array.isArray(saved.selected) ? saved.selected : [];
  } catch { /* Missing, corrupt or undecryptable credentials require a fresh login. */ }
}
function persist() {
  if (!storage) return;
  mkdirSync(TORA_DIR, { recursive: true });
  const temp = `${FILE}.${randomUUID()}.tmp`;
  try {
    const payload = storage.encrypt(JSON.stringify({ account, catalog, selected }));
    writeFileSync(temp, JSON.stringify({ version: 1, payload }), { mode: 0o600 });
    renameSync(temp, FILE);
  } catch {
    try { unlinkSync(temp); } catch { /* Nothing to clean up. */ }
    throw codexError('CODEX_STORAGE_FAILED', '无法安全保存 Codex 授权，请检查本地存储', 500);
  }
}
export function disconnectCodex() {
  load(); generation++; loginSequence++; pending = null; refreshPromise = null;
  catalogPromise = null; catalogChecked = false;
  account = null; catalog = []; selected = [];
  try { unlinkSync(FILE); } catch (error) {
    if (error.code !== 'ENOENT') throw codexError('CODEX_STORAGE_FAILED', '无法删除 Codex 本地授权，请检查文件权限', 500);
  }
}
function requireAccount() {
  load();
  if (!account || account.invalid) throw reauth();
  return account;
}
function claims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); } catch { return {}; }
}
function parseTokens(tokens, previous) {
  const identity = claims(tokens.id_token), access = claims(tokens.access_token);
  const info = identity['https://api.openai.com/auth'] || access['https://api.openai.com/auth'] || {};
  const accountId = info.chatgpt_account_id || previous?.accountId;
  const subject = identity.sub || access.sub || previous?.subject;
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof accountId !== 'string' || !accountId || typeof subject !== 'string' || !subject || !(tokens.refresh_token || previous?.refreshToken)) {
    throw codexError('CODEX_INVALID_AUTH', 'Codex 授权响应无效，请重新登录', 502);
  }
  if (previous && (accountId !== previous.accountId || subject !== previous.subject)) throw reauth();
  const seconds = Number(tokens.expires_in);
  const expiresAt = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Number(access.exp) * 1000 || Date.now() + 3600000;
  return {
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token || previous.refreshToken,
    accountId, subject, expiresAt, connectionId: previous?.connectionId || randomUUID(),
    email: String(identity.email || access['https://api.openai.com/profile']?.email || previous?.email || ''),
    invalid: false,
  };
}
async function request(url, init, signal, timeout = 30000) {
  try {
    return await modelFetch(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  } catch {
    if (signal?.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
    throw codexError('CODEX_NETWORK_ERROR', '无法连接 Codex，请检查网络或系统代理', 502);
  }
}
async function readJson(response) {
  try {
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw Error();
    return JSON.parse(text);
  } catch { throw codexError('CODEX_INVALID_RESPONSE', 'Codex 服务返回了无效响应', 502); }
}
function httpError(status) {
  if (status === 401) return reauth();
  if (status === 429) return codexError('CODEX_RATE_LIMIT', 'Codex 订阅额度不足或请求过于频繁，请稍后重试', 429);
  if (status === 403) return codexError('CODEX_ACCESS_DENIED', 'Codex 未授权，请检查订阅和设备码授权设置', 403);
  return codexError('CODEX_UPSTREAM_ERROR', `Codex 服务暂不可用（HTTP ${status}）`, 502);
}
export { httpError as codexHttpError };

export async function startCodexLogin() {
  load();
  const sequence = ++loginSequence;
  pending = null;
  const response = await request(`${AUTH_URL}/api/accounts/deviceauth/usercode`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!response.ok) throw httpError(response.status);
  const value = await readJson(response);
  if (sequence !== loginSequence) throw expired();
  if (typeof value.device_auth_id !== 'string' || !value.device_auth_id || typeof value.user_code !== 'string' || !value.user_code) throw codexError('CODEX_INVALID_RESPONSE', '无法获取 Codex 验证码', 502);
  const interval = Math.min(60, Math.max(1, Number(value.interval) || 5));
  const expiresIn = Math.min(900, Math.max(1, Number(value.expires_in) || 900));
  pending = { id: randomUUID(), deviceId: value.device_auth_id, userCode: value.user_code, expiresAt: Date.now() + expiresIn * 1000, interval, nextPollAt: 0, promise: null };
  return { flowId: pending.id, userCode: pending.userCode, verificationUrl: `${AUTH_URL}/codex/device`, expiresAt: pending.expiresAt, interval };
}
export function cancelCodexLogin(flowId) {
  if (pending && pending.id !== flowId) return;
  loginSequence++; pending = null;
}
export async function pollCodexLogin(flowId) {
  const flow = pending;
  if (!flow || flow.id !== flowId || flow.expiresAt <= Date.now()) throw expired();
  if (flow.promise) return flow.promise;
  if (Date.now() < flow.nextPollAt) return { status: 'pending', interval: flow.interval };
  flow.nextPollAt = Date.now() + flow.interval * 1000;
  flow.promise = (async () => {
    const response = await request(`${AUTH_URL}/api/accounts/deviceauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_auth_id: flow.deviceId, user_code: flow.userCode }),
    });
    if (pending !== flow || flow.expiresAt <= Date.now()) throw expired();
    if (response.status === 403 || response.status === 404) {
      const body = await response.json().catch(() => ({}));
      if (body.error === 'access_denied' || body.error?.code === 'access_denied') { pending = null; throw httpError(403); }
      return { status: 'pending', interval: flow.interval };
    }
    if (response.status === 429) {
      flow.interval = Math.min(60, Math.max(flow.interval + 5, Number(response.headers.get('retry-after')) || 0));
      flow.nextPollAt = Date.now() + flow.interval * 1000;
      return { status: 'pending', interval: flow.interval };
    }
    if (response.status === 410) { pending = null; throw expired(); }
    if (!response.ok) throw httpError(response.status);
    const result = await readJson(response);
    if (typeof result.authorization_code !== 'string' || typeof result.code_verifier !== 'string') throw codexError('CODEX_INVALID_AUTH', 'Codex 授权响应无效', 502);
    const tokenResponse = await request(`${AUTH_URL}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: result.authorization_code, code_verifier: result.code_verifier, redirect_uri: `${AUTH_URL}/deviceauth/callback`, client_id: CLIENT_ID }).toString(),
    });
    if (!tokenResponse.ok) throw httpError(tokenResponse.status);
    const tokens = parseTokens(await readJson(tokenResponse));
    if (pending !== flow || flow.expiresAt <= Date.now()) throw expired();
    if (account?.accountId !== tokens.accountId || account?.subject !== tokens.subject) { catalog = []; selected = []; }
    generation++; account = tokens; pending = null; refreshPromise = null;
    catalogPromise = null; catalogChecked = false;
    try { persist(); } catch (error) { account = null; catalog = []; selected = []; throw error; }
    return { status: 'connected' };
  })().finally(() => { flow.promise = null; });
  return flow.promise;
}

function waitForAuth(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('已中止'), { code: 'ABORTED' }));
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('已中止'), { code: 'ABORTED' }));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function getCodexAuth({ force = false, signal } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
  const current = requireAccount();
  if (!force && current.expiresAt > Date.now() + 60000) return current;
  if (refreshPromise) return waitForAuth(refreshPromise, signal);
  const version = generation;
  const job = (async () => {
    const response = await request(`${AUTH_URL}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: CLIENT_ID, scope: 'openid profile email' }).toString(),
    });
    if (generation !== version || account !== current) throw reauth();
    if (!response.ok) {
      // Only a definitive token rejection invalidates the connection, not a network outage.
      const body = await response.json().catch(() => ({}));
      const code = body.error?.code || body.error;
      if (response.status === 401 || (response.status === 400 && ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(code))) {
        current.invalid = true; persist(); throw reauth();
      }
      throw httpError(response.status);
    }
    const next = parseTokens(await readJson(response), current);
    if (generation !== version || account !== current) throw reauth();
    account = next; persist(); return next;
  })();
  const tracked = job.finally(() => { if (refreshPromise === tracked) refreshPromise = null; });
  refreshPromise = tracked;
  return waitForAuth(tracked, signal);
}
export function codexHeaders(auth) {
  return { authorization: `Bearer ${auth.accessToken}`, 'chatgpt-account-id': auth.accountId, originator: 'codex_cli_rs', version: CODEX_CLIENT_VERSION };
}
export function assertCodexConnection(connectionId) {
  const current = requireAccount();
  if (connectionId !== current.connectionId) throw reauth();
}

export function fetchCodexModels() {
  load();
  if (catalogPromise) return catalogPromise;
  catalogChecked = true;
  const job = requestCodexModels().finally(() => { if (catalogPromise === job) catalogPromise = null; });
  catalogPromise = job;
  return job;
}

export async function refreshCodexCatalog({ signal } = {}) {
  load();
  if (!account || account.invalid || (catalogChecked && !catalogPromise)) return;
  try { await waitForAuth(fetchCodexModels(), signal); }
  catch (error) {
    if (!catalog.length || !['CODEX_NETWORK_ERROR', 'CODEX_UPSTREAM_ERROR', 'CODEX_RATE_LIMIT'].includes(error.code)) throw error;
  }
}

async function requestCodexModels() {
  let auth = await getCodexAuth();
  let response = await request(`${CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`, { headers: codexHeaders(auth) }, undefined, 15000);
  if (response.status === 401) {
    assertCodexConnection(auth.connectionId);
    auth = await getCodexAuth({ force: true });
    response = await request(`${CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`, { headers: codexHeaders(auth) }, undefined, 15000);
  }
  if (!response.ok) throw httpError(response.status);
  const body = await readJson(response);
  assertCodexConnection(auth.connectionId);
  const entries = body.models || body.data || body.items || body;
  const list = Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? Object.entries(entries).map(([id, value]) => ({ ...value, id })) : [];
  const seen = new Set();
  const models = list.flatMap(entry => {
    const value = typeof entry === 'string' ? { id: entry } : entry;
    const id = value?.slug || value?.id || value?.model || value?.name;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || seen.has(id) || value.visibility === 'hide') return [];
    seen.add(id);
    const efforts = (value.supported_reasoning_levels || []).map(level => typeof level === 'string' ? level : level.effort).filter(level => EFFORTS.includes(level));
    // Maximum-context mode must not inherit the upstream CLI's smaller default window.
    const context = [value.max_context_window, value.context_window].map(Number).find(tokens => Number.isSafeInteger(tokens) && tokens >= 1024 && tokens <= 10000000) ?? 128000;
    const output = Number(value.max_output_tokens);
    return [{ id, name: String(value.display_name || id), context,
      maxOutput: Number.isSafeInteger(output) && output > 0 && output < 1000000 ? output : 16384,
      vision: value.input_modalities?.includes('image') === true, effortsDeclared: efforts.length > 0,
      efforts: efforts.length ? [...new Set(efforts)] : ['low', 'medium', 'high'] }];
  });
  if (!models.length) throw codexError('CODEX_NO_MODELS', '当前 Codex 账号没有返回可用模型，请检查订阅权限', 502);
  catalog = models; persist();
  return { models: catalog, selected: selected.map(value => ({ ...value })) };
}
export function saveCodexModels(models) {
  requireAccount();
  if (!Array.isArray(models) || models.length > 200 || models.some(value => typeof value?.model !== 'string' || !catalog.some(model => model.id === value.model) || typeof value.enabled !== 'boolean')) throw codexError('CODEX_INVALID_MODELS', '请选择此账号目录中的 Codex 模型');
  selected = [...new Map(models.map(value => [value.model, { model: value.model, enabled: value.enabled }])).values()];
  persist(); return codexStatus();
}
export function codexStatus() {
  load();
  const email = account?.email || '';
  return { connected: !!account && !account.invalid, needsReauth: !!account?.invalid, storage: storage ? 'encrypted' : 'memory',
    email: email.replace(/^(.).*(@.*)$/, '$1***$2'),
    models: selected.map(value => ({ ...value, id: `codex:${value.model}`, provider: CODEX_PROVIDER, label: 'Codex', baseURL: CODEX_BASE_URL, apiKeySet: false, localOnly: true })),
  };
}
export function codexModelCards() {
  load();
  if (!account || account.invalid) return [];
  return selected.filter(value => value.enabled).flatMap(value => {
    const model = catalog.find(item => item.id === value.model);
    return model ? [{ type: 'chat_model', name: model.id, label: model.name, status: 'active', deprecated_at: null,
      input_types: model.vision ? ['text', 'image'] : ['text'], output_types: ['text'], context_size: model.context, output_size: model.maxOutput,
      parameter_schema: { type: 'object', properties: model.effortsDeclared === true ? { thinkingEffort: { type: 'string', enum: model.efforts, default: model.efforts.includes('high') ? 'high' : model.efforts.at(-1) } } : {} }, parameters_overrides: {},
    }] : [];
  });
}
export function resolveCodexModel(model) {
  const current = requireAccount();
  const metadata = catalog.find(value => value.id === model);
  if (!metadata || !selected.some(value => value.model === model && value.enabled)) throw codexError('CODEX_INVALID_MODELS', '此 Codex 模型未启用，请在添加模型页面管理连接');
  return { provider: CODEX_PROVIDER, baseURL: CODEX_BASE_URL, apiKey: '', model, vision: metadata.vision,
    codexConnectionId: current.connectionId, codexEfforts: metadata.efforts,
    maxTokensBudget: Math.max(1024, metadata.context - metadata.maxOutput - 8192) };
}
