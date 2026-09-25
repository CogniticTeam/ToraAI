// 安全基元：路径沙箱 / 子进程环境净化 / 密钥脱敏
//
// 三件事各自独立，但都属于"模型不能悄悄越界"这一条底线：
//  1. resolveInRoots —— 工具只能碰工作目录（及其显式声明的额外根）里的文件。
//     绝对路径与 ../../ 都会被解析后比对，符号链接也按真实路径比对。
//  2. buildChildEnv —— 子进程不再继承完整 process.env；密钥类变量一律剥离。
//  3. redact —— 出站（发给模型 / 写日志）的文本过一遍脱敏，把已知密钥换成 ***。
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { LEGACY_ENV_PREFIX } from './legacy-migration.js';

// ---------------------------------------------------------------- 路径沙箱

/** realpath，失败则退回原值（文件可能还不存在） */
export function realpathOrSelf(p) {
  try { return realpathSync.native(p); } catch { return p; }
}

/**
 * 把路径解析成真实绝对路径，即使尾段还不存在。
 * 逐级向上找到存在的祖先做 realpath，再把剩余段拼回去 —— 这样
 * `/workdir/new/dir/file.txt`（尚不存在）也能拿到正确的真实前缀，
 * 从而挡住"父目录是指向工作目录外的符号链接"这种绕过。
 */
export function realpathAllowMissing(p) {
  const abs = resolve(p);
  const parts = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return parts.length ? resolve(real, ...parts.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // 一路到根都不存在
      parts.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * 建立沙箱根集合。第一个元素是主根（工作目录），后续为显式放行的额外根。
 * @param {string} cwd
 * @param {string[]} [allowedRoots]
 */
export function createRoots(cwd, allowedRoots = []) {
  const list = [cwd, ...(Array.isArray(allowedRoots) ? allowedRoots : [])].filter(Boolean);
  const roots = [];
  for (const p of list) {
    const real = realpathAllowMissing(p);
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

export function isInside(child, root) {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * createRoots 的带缓存版本。
 * 工具每次调用都要解析路径，而 realpath 是系统调用 —— 缓存住避免重复。
 * 注意：必须缓存「已 realpath 的根」，直接拿 ctx.cwd 当根是错的
 * （macOS 上 /var 是 /private/var 的符号链接，不归一化会误判越界）。
 * @param {string} cwd
 * @param {string[]} [allowedRoots]
 */
const rootsCache = new Map();
export function cachedRoots(cwd, allowedRoots = []) {
  if (!cwd) return [];
  const extra = Array.isArray(allowedRoots) ? allowedRoots.filter(Boolean) : [];
  const key = `${cwd}\u0000${extra.join('\u0000')}`;
  let hit = rootsCache.get(key);
  if (!hit) {
    hit = createRoots(cwd, extra);
    if (rootsCache.size > 64) rootsCache.clear();
    rootsCache.set(key, hit);
  }
  return hit;
}

/**
 * 把用户/模型给的路径解析到沙箱内。
 * @returns {{ok:true, path:string} | {ok:false, reason:string}}
 */
export function resolveInRoots(input, roots) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, reason: '路径不能为空。' };
  }
  if (!roots?.length) {
    return { ok: false, reason: '未设置工作目录，拒绝访问文件系统。' };
  }
  const primary = roots[0];
  const raw = isAbsolute(input) ? resolve(input) : resolve(primary, input);
  const real = realpathAllowMissing(raw);
  if (roots.some((r) => isInside(real, r))) return { ok: true, path: real };
  return {
    ok: false,
    reason:
      `路径越界：${input} 解析为 ${real}，不在当前工作目录内。` +
      `工具只能读写工作目录${roots.length > 1 ? '及其显式放行的目录' : ''}里的文件。` +
      `如确实需要访问该位置，请让用户在会话里把该目录设为工作目录（或加入 allowed_roots 配置）。`
  };
}

/** 工具输出里统一使用的越界提示（保持与 resolveInRoots 文案一致） */
export function outsideMessage(input) {
  return `路径越界：${input} 不在当前工作目录内，已拒绝访问。`;
}

// ------------------------------------------------------- 子进程环境变量净化

/**
 * 密钥类环境变量名（不区分大小写）。
 * 名字里带这些词的变量一律不传给孩子进程 —— 覆盖 OPENAI_API_KEY /
 * COCODE_API_KEY / AWS_SECRET_ACCESS_KEY / GITHUB_TOKEN / *_PASSWORD 等主流形态。
 */
const SECRET_NAME_RE = /(^|[_-])(API[_-]?KEY|KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PASS|AUTH|COOKIE|SESSION)([_-]|$)/i;

/** 不看值、只看名字：反正子进程不需要这些 */
const EXPLICIT_DENY = new Set([
  'NODE_OPTIONS',        // 注入 shim / --require 的入口，不该传给工具
  'ELECTRON_RUN_AS_NODE'
]);

/** 各家模型/云厂商的凭证前缀，整组剥离 */
const PROVIDER_PREFIX_RE = /^(COCODE|OPENAI|ANTHROPIC|DASHSCOPE|MOONSHOT|ZHIPU|GEMINI|GOOGLE|AZURE|BEDROCK|DEEPSEEK|GROQ|MISTRAL|OPENROUTER|SILICONFLOW|MINIMAX|XIAOMI)_/i;

export function isSecretEnvName(name) {
  return SECRET_NAME_RE.test(name) || PROVIDER_PREFIX_RE.test(name) || name.toUpperCase().startsWith(`${LEGACY_ENV_PREFIX}_`);
}

/**
 * 生成给 bash 子进程用的环境变量：剔除一切看起来像密钥的变量。
 * 保留 PATH / HOME / LANG / TERM 等正常构建所需的部分 —— 不做纯白名单，
 * 否则 npm / cargo / go 之类的工具链会大面积失灵；按名字识别密钥的
 * 覆盖率足够高，且不会误伤常规变量。
 */
export function buildChildEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (EXPLICIT_DENY.has(k)) continue;
    if (isSecretEnvName(k)) continue;
    out[k] = v;
  }
  return Object.assign(out, extra);
}

/** 给模型/用户看的环境摘要：只报"剥掉了几个"，不报名字与值 */
export function envSanitizeSummary(env = process.env) {
  let dropped = 0;
  for (const k of Object.keys(env)) if (EXPLICIT_DENY.has(k) || isSecretEnvName(k)) dropped++;
  return dropped;
}

// ------------------------------------------------------------------ 脱敏

const registry = new Set();

function mask(secret) {
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 4)}***${secret.slice(-2)}`;
}

/** 登记一个字面量密钥（>=8 字符，避免把常见短串全替换掉） */
export function registerSecret(v) {
  if (typeof v === 'string' && v.length >= 8) registry.add(v);
}

export function registerSecrets(list) {
  for (const v of list ?? []) registerSecret(v);
}

/** 从配置对象里自动搜集密钥（apiKey / modelList[].apiKey / 凭证） */
export function registerSecretsFromConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  registerSecret(cfg.apiKey);
  for (const m of Array.isArray(cfg.modelList) ? cfg.modelList : []) registerSecret(m?.apiKey);
}

export function resetSecrets() { registry.clear(); }

export function secretCount() { return registry.size; }

// 形态识别：即便密钥没登记过，也能挡掉最常见的几种打印形态
const PATTERNS = [
  // Bearer <token>
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, '$1***'],
  // sk-xxxx / sk-proj-xxxx / ghp_xxx 等厂商前缀
  [/\b(sk|pk|rk|ghp|gho|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, (m) => mask(m)],
  // key=value / "api_key": "value" / Authorization: xxx
  [/(["']?(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/-]{12,})/gi,
    '$1***']
];

/** 对一段文本做脱敏。非字符串原样返回。 */
export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const secret of registry) {
    if (secret && out.includes(secret)) out = out.split(secret).join(mask(secret));
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * 深度脱敏：把对象/数组里的所有字符串过一遍 redact，返回新对象。
 * 用于"要交给模型或落日志的结构化数据"。
 */
export function redactDeep(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}
