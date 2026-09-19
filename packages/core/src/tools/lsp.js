// LSP 工具：跳定义 / 找引用 / 诊断 / 符号列表 / hover
//
// 两层实现：
//  1. 本地层（永远可用，零依赖）：正则符号索引 + 词边界引用扫描 + 轻量静态诊断。
//     准确率对「让模型少翻几个文件」这个用途足够，且不需要装任何东西。
//  2. 真 LSP 层（可选）：cfg.lspServers 里配了对应扩展名的 server 时，
//     起 stdio JSON-RPC 拿精确结果（含类型诊断）。任何失败（没装、握手超时、
//     进程崩）都静默回退到本地层，并在结果里注明来源，不让模型误以为拿到了类型信息。
//
// 索引落盘在 ~/.vega/index/<rootHash>.symbols.json，按 mtime 增量重建。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extname, join, relative, sep } from 'node:path';
import { IGNORE_DIRS, langOf, walkCodeFiles } from './repomap.js';
import { VEGA_DIR } from '../config.js';
import { buildChildEnv, resolveInRoots } from '../security.js';

export const INDEX_DIR = join(VEGA_DIR, 'index');
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_SCAN = 8000;

// ---------------------------------------------------------------- 文件遍历

/** 相对 cwd 的展示路径（统一用 / 分隔，跨平台可比） */
function rel(cwd, p) {
  return relative(cwd, p).split(sep).join('/');
}

function rootHash(root) {
  return createHash('sha1').update(root).digest('hex').slice(0, 16);
}

function ensureDir(d) {
  try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 定义提取

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new',
  'await', 'else', 'do', 'try', 'finally', 'case', 'delete', 'void', 'in', 'of', 'throw'
]);

/** 语言 → [{re, kind}]，re 的第 1 组是符号名 */
const DEF_RES = {
  js: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
    // 变量只在顶层/导出位置算符号：函数体里的 const p = ... 是局部变量，不是「定义」
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: 'variable', top: true },
    // 类方法 / 对象字面量方法：靠缩进 + 关键字黑名单挡住 if/for 这类误判
    { re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/, kind: 'method', method: true }
  ],
  py: [
    { re: /^\s*(?:async\s+)?def\s+(\w+)/, kind: 'function' },
    { re: /^\s*class\s+(\w+)/, kind: 'class' },
    { re: /^([A-Z_][A-Z0-9_]*)\s*=/, kind: 'variable' }
  ],
  go: [
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*type\s+([A-Za-z_]\w*)/, kind: 'type' }
  ],
  rs: [
    { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*(?:pub\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/, kind: 'type' },
    { re: /^\s*(?:pub\s+)?(?:const|static)\s+([A-Za-z_]\w*)/, kind: 'variable' }
  ],
  jvm: [
    { re: /^\s*(?:public|private|protected|static|final|abstract|synchronized|\s)*[\w<>\[\],.\s]+\s+([A-Za-z_]\w*)\s*\([^()]*\)\s*\{/, kind: 'method', method: true },
    { re: /^\s*(?:public|private|protected|final|abstract|sealed|\s)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: 'class' }
  ],
  sh: [
    { re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/, kind: 'function' }
  ]
};

/** 行是否是可忽略的噪声（注释行 / 纯 import 行） */
function isNoiseLine(t) {
  return !t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#') || t.startsWith('import ') || t.startsWith('export {');
}

/**
 * 从一份源码提取「带行号的定义」。
 * @returns {Array<{name:string,kind:string,line:number}>}
 */
export function extractDefinitions(text, lang) {
  const rules = DEF_RES[lang];
  if (!rules) return [];
  const out = [];
  const seen = new Set();
  const lines = text.split('\n');
  const n = Math.min(lines.length, MAX_LINE_SCAN);
  for (let i = 0; i < n; i++) {
    const line = lines[i].trimEnd();
    if (isNoiseLine(line.trim())) continue;
    for (const r of rules) {
      const m = r.re.exec(line);
      if (!m) continue;
      const name = m[1];
      if (!name || JS_KEYWORDS.has(name)) continue;
      if (r.method && (line.trimStart() === line || line.startsWith('}') || line.startsWith(')'))) continue;
      // top:true 的规则只认顶层（顶格）声明，避免把函数内的局部变量当符号
      if (r.top && line !== line.trimStart() && !/^\s*export\b/.test(line)) continue;
      const key = `${name}@${i}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({ name, kind: r.kind, line: i + 1 });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 符号索引（带缓存）

function indexPath(root) {
  return join(INDEX_DIR, `${rootHash(root)}.symbols.json`);
}

function readIndex(root) {
  const p = indexPath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function writeIndex(root, idx) {
  ensureDir(INDEX_DIR);
  try { writeFileSync(indexPath(root), JSON.stringify(idx)); } catch { /* 索引写不进去不该挡路 */ }
}

/**
 * 建立（或增量更新）工作目录的符号索引。
 * @param {string} cwd
 * @param {{force?:boolean}} [opts]
 * @returns {{ok:boolean, root:string, files:number, symbols:Array, reused:number, reason?:string}}
 */
export function buildSymbolIndex(cwd, { force = false } = {}) {
  if (!cwd) return { ok: false, root: null, files: 0, symbols: [], reused: 0, reason: '未选择工作目录' };
  const prev = force ? null : readIndex(cwd);
  const stamp = new Map((prev?.files || []).map((f) => [f.path, f]));
  const walked = walkCodeFiles(cwd);
  if (!walked.length) return { ok: true, root: cwd, files: 0, symbols: [], reused: 0, reason: '没有可索引的源码文件' };

  const fileStamps = [];
  const symbols = [];
  let reused = 0;
  for (const f of walked) {
    const key = rel(cwd, f.path);
    const old = stamp.get(key);
    if (old && old.mtime === f.mtime && old.size === f.size && Array.isArray(old.symbols)) {
      reused++;
      fileStamps.push({ path: key, mtime: f.mtime, size: f.size, symbols: old.symbols });
      for (const s of old.symbols) symbols.push({ ...s, file: key });
      continue;
    }
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch { continue; }
    const defs = extractDefinitions(text, f.lang).slice(0, 400);
    fileStamps.push({ path: key, mtime: f.mtime, size: f.size, symbols: defs });
    for (const s of defs) symbols.push({ ...s, file: key });
  }
  writeIndex(cwd, { version: 1, root: cwd, builtAt: Date.now(), files: fileStamps });
  return { ok: true, root: cwd, files: fileStamps.length, symbols, reused };
}

// indexedSymbols：优先走缓存，没有就建
let _indexCache = { root: null, at: 0, symbols: [] };
function indexedSymbols(cwd) {
  if (_indexCache.root === cwd && Date.now() - _indexCache.at < 20_000) return _indexCache.symbols;
  const r = buildSymbolIndex(cwd);
  _indexCache = { root: cwd, at: Date.now(), symbols: r.symbols || [] };
  return _indexCache.symbols;
}

/** 跳定义：按名字找定义点，同名多个按「同文件优先 → 同目录优先 → 顺序」排序 */
export function findDefinition(cwd, name, { file = null, limit = 10 } = {}) {
  if (!cwd || !name) return [];
  const all = indexedSymbols(cwd).filter((s) => s.name === name);
  if (!all.length) return [];
  const dir = file && file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const score = (s) => (file && s.file === file ? 0 : (dir && s.file.startsWith(dir + '/') ? 1 : 2));
  return all.sort((a, b) => score(a) - score(b) || a.file.localeCompare(b.file) || a.line - b.line).slice(0, limit);
}

/**
 * 找引用：词边界扫描全仓源码（跳过索引排除的目录）。
 * 返回 {file,line,column,text,in_comment}，in_comment 是启发式标记，让模型知道可信度。
 */
export function findReferences(cwd, name, { file = null, limit = 60, excludeDefinition = true } = {}) {
  if (!cwd || !name) return { hits: [], scanned: 0, truncated: false };
  let re;
  try { re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`); }
  catch { return { hits: [], scanned: 0, truncated: false }; }
  const files = file ? [{ path: join(cwd, file) }] : walkCodeFiles(cwd);
  const defs = new Set();
  if (excludeDefinition) for (const d of findDefinition(cwd, name, { limit: 50 })) defs.add(`${d.file}:${d.line}`);
  const hits = [];
  let scanned = 0;
  let truncated = false;
  for (const f of files) {
    if (hits.length >= limit) { truncated = true; break; }
    scanned++;
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch { continue; }
    const key = rel(cwd, f.path);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && i < MAX_LINE_SCAN; i++) {
      const line = lines[i];
      const m = re.exec(line);
      if (!m) continue;
      if (excludeDefinition && defs.has(`${key}:${i + 1}`)) continue;
      hits.push({
        file: key,
        line: i + 1,
        column: m.index + 1,
        text: line.trim().slice(0, 200),
        in_comment: /^\s*(\/\/|#|\*|\/\*)/.test(line)
      });
      if (hits.length >= limit) { truncated = true; break; }
    }
  }
  return { hits, scanned, truncated };
}

// ---------------------------------------------------------------- 轻量诊断

/** 粗略剥掉字符串/注释/正则，让括号计数不被字面量里的括号带偏 */
function stripLiterals(line, lang) {
  if (lang === 'py' || lang === 'sh') {
    return line.replace(/#.*$/, '').replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""');
  }
  return line
    .replace(/\/\/.*$/, '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
    // 正则字面量里常有 (){}[]（如 /[;&|]/），不剥掉会让括号计数彻底失真
    .replace(/(^|[=(,:;\s![&|?{])\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[gimsuy]*/g, '$1""');
}

const TODO_RE = /\b(TODO|FIXME|XXX|HACK)\b[:\s]*(.{0,80})/;

/** 单个文件的轻量诊断（不追求完备，追求「零噪声 + 真问题」） */
export function diagnoseFile(cwd, file, lang, text) {
  const out = [];
  const lines = text.split('\n');
  const push = (line, severity, code, message) => out.push({ file, line, severity, code, message });
  const stacks = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set(Object.values(stacks));
  let depth = 0;
  let backticks = 0;
  const defSeen = new Map();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripLiterals(raw, lang);
    const ln = i + 1;
    // 反引号奇偶：跨行模板字符串是括号启发式最大的误报来源，遇到就放弃这条规则
    for (const ch of line) if (ch === '`') backticks++;

    if (lang !== 'md' && /^(<{7}|={7}|>{7})/.test(raw)) push(ln, 'error', 'merge-conflict', '残留的合并冲突标记');

    for (const ch of line) {
      if (stacks[ch]) depth++;
      else if (closers.has(ch)) depth--;
    }

    if (lang === 'js' && /\bdebugger\b/.test(line)) push(ln, 'warning', 'debugger', 'debugger 语句残留');

    const t = TODO_RE.exec(raw); // 用原始行：TODO 基本都在注释里，剥掉注释就什么也找不到了
    if (t) push(ln, 'info', 'todo', `${t[1]}${t[2] ? ': ' + t[2].trim() : ''}`);

    // 空 catch：吞掉异常会让排查无从下手
    if (lang === 'js' && /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) {
      push(ln, 'warning', 'empty-catch', '空 catch 块：异常被静默吞掉');
    }

    // 相对 import 指向不存在的文件
    const im = lang === 'js'
      ? /^\s*(?:import[^'"]*from\s*|export[^'"]*from\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/.exec(line)
      : null;
    if (im) {
      const spec = im[1];
      const base = join(cwd, file, '..', spec);
      const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}.json`, join(base, 'index.js'), join(base, 'index.ts')];
      if (!candidates.some((c) => existsSync(c))) {
        push(ln, 'warning', 'missing-import', `相对导入不存在: ${spec}`);
      }
    }

    // 同名顶层定义（只查 function/class/type；局部变量/方法同名是正常现象，不该报）
    for (const d of extractDefinitions(raw, lang)) {
      if (!['function', 'class', 'type'].includes(d.kind)) continue;
      const prev = defSeen.get(d.name);
      if (prev) push(ln, 'warning', 'duplicate-definition', `同名定义重复：${d.name}（首次在第 ${prev} 行）`);
      else defSeen.set(d.name, ln);
    }
  }
  // 括号平衡只是启发式（跨行模板字符串、正则、JSX 都会干扰），因此只在
  // 反引号配对正常时给出，且降级为 info —— 宁可少报，也不给模型塞假警报。
  if (depth !== 0 && backticks % 2 === 0 && (lang === 'js' || lang === 'jvm' || lang === 'go' || lang === 'rs')) {
    push(lines.length, 'info', 'suspicious-brackets', `括号计数不平衡（差 ${depth}，启发式判断，可能是跨行字符串或多行 JSX 导致）`);
  }
  return out;
}

/**
 * 诊断：给定文件/目录，返回问题列表（按严重度排序）。
 */
export function runDiagnostics(cwd, { path: target = null, limit = 60 } = {}) {
  if (!cwd) return { items: [], scanned: 0 };
  let files;
  if (target) {
    const abs = join(cwd, target);
    if (existsSync(abs) && statSync(abs).isFile()) files = [{ path: abs, lang: langOf(abs) }];
    else files = walkCodeFiles(abs);
  } else {
    files = walkCodeFiles(cwd, { maxFiles: 800 });
  }
  const rank = { error: 0, warning: 1, info: 2 };
  const items = [];
  let scanned = 0;
  for (const f of files) {
    if (items.length >= limit * 3) break;
    if (!f.lang) continue;
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch { continue; }
    scanned++;
    for (const d of diagnoseFile(cwd, rel(cwd, f.path), f.lang, text)) items.push(d);
  }
  items.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);
  return { items: items.slice(0, limit), total: items.length, scanned };
}

// ---------------------------------------------------------------- 真 LSP（可选）

const clientCache = new Map(); // `${cwd}|${ext}` -> LspClient

function lspConfigFor(cfg, filePath) {
  const servers = cfg?.lspServers;
  if (!servers || typeof servers !== 'object') return null;
  const ext = extname(filePath || '').toLowerCase();
  const entry = servers[ext] || servers['*'];
  if (!entry) return null;
  if (typeof entry === 'string') return { command: entry, args: [] };
  if (Array.isArray(entry)) return { command: entry[0], args: entry.slice(1) };
  if (entry.command) {
    return {
      command: entry.command,
      args: entry.args || [],
      // 有些 server 必须靠初始化参数才知道去哪找语言运行时。最典型的就是
      // typescript-language-server：它要在**被打开的项目里**找到 typescript，
      // 而绝大多数项目并不装 typescript —— 不给 tsserver.path 就会直接退出。
      initializationOptions: entry.initializationOptions || entry.initOptions || null,
      env: entry.env || null
    };
  }
  return null;
}

/** 极简 stdio LSP 客户端：只实现本工具需要的那几个方法 */
class LspClient {
  constructor(command, args, cwd, opts = {}) {
    this.cwd = cwd;
    this.initializationOptions = opts.initializationOptions || null;
    this.seq = 0;
    this.pending = new Map();
    this.diagnostics = new Map();
    this.buf = Buffer.alloc(0);
    this.dead = false;
    this.ready = null;
    // 失败原因必须留下来。"静默回退"是给用户看的体验，不是给排障看的 ——
    // 配错了却只看到"用了本地索引"，用户会以为功能没做，而不是自己配错了。
    this.lastError = null;
    this.proc = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(process.env, { FORCE_COLOR: '0', ...(opts.env || {}) })
    });
    const fail = (msg) => {
      this.dead = true;
      this.lastError = this.lastError || msg;
      for (const [, p] of this.pending) p.reject(new Error(this.lastError));
      this.pending.clear();
    };
    this.proc.on('error', (e) => fail(`启动失败：${e?.message || e}`));
    this.proc.on('exit', (code, signal) => fail(`进程退出（code=${code}${signal ? ', signal=' + signal : ''}）`));
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.stderrTail = '';
    this.proc.stderr.on('data', (d) => {
      // server 的 stderr 平时是日志，出错时是唯一线索 —— 留最后一小段
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    this.ready = this._handshake();
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const head = this.buf.slice(0, sep).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(head);
      if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.slice(start, start + len).toString('utf8');
      this.buf = this.buf.slice(start + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'LSP 错误'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics || []);
      return;
    }
    if (msg.method && msg.id != null) this._send({ jsonrpc: '2.0', id: msg.id, result: null }); // 不支持的请求礼貌回空
  }

  _send(obj) {
    if (this.dead) return;
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    try { this.proc.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`); this.proc.stdin.write(payload); }
    catch { this.dead = true; }
  }

  request(method, params, timeoutMs = 8000) {
    if (this.dead) return Promise.reject(new Error(this.lastError || 'LSP 不可用'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`LSP ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this._send({ jsonrpc: '2.0', method, params }); }

  async _handshake() {
    // 20s：真 server 首次 initialize 要拉起 tsserver/索引，8s 在中等仓库上就会超时，
    // 而超时的后果是"静默回退到本地索引"——用户会以为配了没用。
    const params = {
      processId: process.pid,
      rootUri: `file://${this.cwd}`,
      capabilities: { textDocument: { definition: {}, references: {}, hover: {}, documentSymbol: {}, publishDiagnostics: {} } }
    };
    if (this.initializationOptions) params.initializationOptions = this.initializationOptions;
    await this.request('initialize', params, 20000);
    this.notify('initialized', {});
  }

  async waitReady() { return this.ready; }

  /** 人类可读的失败原因（含 server 的 stderr 尾巴，通常比 exit code 有用得多） */
  reason() {
    const tail = (this.stderrTail || '').trim().split('\n').filter(Boolean).slice(-2).join(' / ');
    if (this.lastError && tail) return `${this.lastError}｜${tail.slice(0, 200)}`;
    return this.lastError || tail.slice(0, 200) || null;
  }

  dispose() {
    try { this.notify('exit', {}); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
    this.dead = true;
  }
}

function getLspClient(cwd, cfg, filePath) {
  const conf = lspConfigFor(cfg, filePath);
  if (!conf) return null;
  const key = `${cwd}|${extname(filePath || '').toLowerCase()}`;
  let c = clientCache.get(key);
  if (c && !c.dead) return c;
  try {
    c = new LspClient(conf.command, conf.args, cwd, {
      initializationOptions: conf.initializationOptions,
      env: conf.env
    });
    clientCache.set(key, c);
    return c;
  } catch { return null; }
}

export function disposeLspClients() {
  for (const [, c] of clientCache) c.dispose();
  clientCache.clear();
}

/** 把 file:line 转成 LSP 位置参数（列取该行首个非空白）+ didOpen */
function openDoc(client, cwd, file) {
  const abs = join(cwd, file);
  if (!existsSync(abs)) return null;
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { return null; }
  const uri = `file://${abs}`;
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: (langOf(abs) || 'plaintext'), version: 1, text }
  });
  return { uri, text };
}

function lspLocationsToResult(cwd, locs) {
  const arr = Array.isArray(locs) ? locs : (locs ? [locs] : []);
  return arr.slice(0, 40).map((l) => {
    const uri = l.uri || l.targetUri;
    const range = l.range || l.targetSelectionRange || {};
    const file = String(uri || '').replace(/^file:\/\//, '');
    return { file: rel(cwd, file), line: (range.start?.line ?? 0) + 1, column: (range.start?.character ?? 0) + 1 };
  });
}

// ---------------------------------------------------------------- 工具

function fmtLocations(list) {
  return list.map((l) => `  ${l.file}:${l.line}${l.column ? ':' + l.column : ''}`).join('\n');
}

export const lspTool = {
  name: 'Lsp',
  description:
    '代码导航与诊断：action=definition 跳定义 / references 找引用 / symbols 列符号 / diagnostics 查问题 / hover 看上下文。' +
    'definition、references、hover 需要 name（符号名）；file/path 可选。结果是本地索引（配了 lspServers 才是精确 LSP）。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['definition', 'references', 'symbols', 'diagnostics', 'hover'], description: '要执行的动作' },
      name: { type: 'string', description: '符号名（definition / references / hover 必填）' },
      file: { type: 'string', description: '限定文件或当前编辑的文件（相对工作目录）' },
      path: { type: 'string', description: 'symbols / diagnostics 的目标文件或目录（默认整个工作目录）' },
      limit: { type: 'number', description: '结果上限' }
    },
    required: ['action']
  },
  async execute(args = {}, ctx = {}) {
    const cwd = ctx.cwd;
    if (!cwd) return '未选择工作目录。';
    const action = String(args.action || '').toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 0)) || undefined;

    if (action === 'symbols') {
      const target = args.path ? resolveInRoots(args.path, ctx.sandboxRoots || []) : { ok: true, path: cwd };
      if (!target.ok) return target.reason;
      const isDir = existsSync(target.path) && statSync(target.path).isDirectory();
      const all = isDir
        ? buildSymbolIndex(target.path).symbols.map((s) => ({ ...s, file: rel(cwd, join(target.path, s.file)) }))
        : indexedSymbols(cwd);
      if (!all.length) return '没有找到符号（工作目录里可能没有可识别的源码）。';
      const shown = all.slice(0, limit || 200);
      const byFile = new Map();
      for (const s of shown) {
        if (!byFile.has(s.file)) byFile.set(s.file, []);
        byFile.get(s.file).push(s);
      }
      const lines = [`# 符号（${shown.length}${all.length > shown.length ? `/${all.length}` : ''}，来源：本地索引）`];
      for (const [f, list] of byFile) {
        lines.push(`${f}`);
        for (const s of list.slice(0, 40)) lines.push(`  ${s.line}: [${s.kind}] ${s.name}`);
      }
      return lines.join('\n');
    }

    if (action === 'diagnostics') {
      const r = runDiagnostics(cwd, { path: args.path || null, limit: limit || 60 });
      if (!r.items.length) return `扫描了 ${r.scanned} 个文件，没有发现问题。`;
      const head = r.total > r.items.length ? `（共 ${r.total} 条，显示前 ${r.items.length} 条）` : '';
      return `# 诊断${head}\n` + r.items.map((d) => `  ${d.severity === 'error' ? '✗' : d.severity === 'warning' ? '!' : 'i'} ${d.file}:${d.line} [${d.code}] ${d.message}`).join('\n');
    }

    const name = String(args.name || '').trim();
    if (!name) return `action=${action} 需要 name 参数（符号名）。`;

    // 先试真 LSP（配了 server 且文件已知）
    let lspWhy = null;
    const tryLsp = async () => {
      if (!args.file) return null;
      const client = getLspClient(cwd, ctx.cfg || {}, args.file);
      if (!client) return null;
      try {
        await client.waitReady();
        const doc = openDoc(client, cwd, args.file);
        if (!doc) return null;
        const lines = doc.text.split('\n');
        const wordRe = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?![\\w$])`);
        // 用**用法**的位置去问定义，而不是 import / require 行 —— 在 import 行上
        // 问 definition，TS 会说"定义就是这个 import 绑定本身"，得到 use.ts:1
        // 这种没用的答案。找不到用法时才退回第一个匹配。
        let lineIdx = lines.findIndex((l) => wordRe.test(l) && !/^\s*(import\b|export\b[^=]*\bfrom\b|.*\brequire\s*\()/.test(l));
        if (lineIdx < 0) lineIdx = lines.findIndex((l) => wordRe.test(l));
        if (lineIdx < 0) lineIdx = 0;
        const character = Math.max(0, (lines[lineIdx] || '').indexOf(name));
        const pos = { textDocument: { uri: doc.uri }, position: { line: lineIdx, character: Math.max(0, character) } };
        if (action === 'definition') {
          const res = await client.request('textDocument/definition', pos);
          const locs = lspLocationsToResult(cwd, res);
          if (!locs.length) return null;
          let text = `# 定义（LSP）\n${fmtLocations(locs)}`;
          // typescript-language-server 对 `import { x }` 这类**别名**会停在 import
          // 绑定行（同文件），而人想看的是源码里的声明。两种情况都摆出来，别让
          // 模型以为"定义就是这个 import"。
          if (locs.every((l) => l.file === args.file)) {
            const fallback = findDefinition(cwd, name, { file: args.file, limit: 3 })
              .filter((d) => !locs.some((l) => l.file === d.file && l.line === d.line));
            if (fallback.length) {
              text += `\n（上面是 import 绑定位置；源码声明可能在：）\n${fmtLocations(fallback)}`;
            }
          }
          return { source: 'LSP', text };
        }
        if (action === 'references') {
          const res = await client.request('textDocument/references', { ...pos, context: { includeDeclaration: false } });
          const locs = lspLocationsToResult(cwd, res);
          return locs.length ? { source: 'LSP', text: `# 引用（LSP，${locs.length} 处）\n${fmtLocations(locs)}` } : null;
        }
        if (action === 'hover') {
          const res = await client.request('textDocument/hover', pos);
          const s = res?.contents?.value || res?.contents;
          if (typeof s === 'string' && s.trim()) return { source: 'LSP', text: `# Hover（LSP）\n${s.slice(0, 1200)}` };
          return null;
        }
      } catch (e) {
        lspWhy = client.reason?.() || e?.message || '未知错误';
        return null;
      }
      return null;
    };

    const viaLsp = await tryLsp();
    if (viaLsp) return viaLsp.text;

    // 本地回退（若配了 lspServers 却没走成 LSP，把原因带上 —— 否则用户无法区分
    // "没配所以用本地索引" 与 "配了但启动失败"）
    const why = lspWhy ? `\n（已配置 lspServers 但真 LSP 不可用：${lspWhy}；已回退到本地索引）` : '';
    if (action === 'definition' || action === 'hover') {
      const defs = findDefinition(cwd, name, { file: args.file || null, limit: limit || 10 });
      if (!defs.length) {
        usedIndex(cwd);
        return `本地索引里没有找到 ${name} 的定义。可能原因：名字拼写不同、定义在其他未被索引的目录、或它是运行时生成的符号。可以试试 Grep 或 Search。${why}`;
      }
      const head = action === 'hover'
        ? `# ${name}（本地索引；无类型信息）`
        : `# 定义（本地索引）`;
      const lines = [head];
      for (const d of defs) {
        lines.push(`  ${d.file}:${d.line} [${d.kind}] ${d.name}`);
        if (action === 'hover') {
          try {
            const text = readFileSync(join(cwd, d.file), 'utf8').split('\n');
            const from = Math.max(0, d.line - 4);
            lines.push(text.slice(from, d.line + 2).map((l, i) => `    ${from + i + 1}| ${l.slice(0, 160)}`).join('\n'));
          } catch { /* ignore */ }
        }
      }
      return lines.join('\n') + why;
    }

    if (action === 'references') {
      const r = findReferences(cwd, name, { file: args.file || null, limit: limit || 60 });
      if (!r.hits.length) return `没有找到 ${name} 的引用（扫描了 ${r.scanned} 个文件）。${why}`;
      const head = `# 引用（本地扫描，${r.hits.length}${r.truncated ? '+' : ''} 处，${r.scanned} 个文件）`;
      return head + '\n' + r.hits.map((h) => `  ${h.in_comment ? '(注释) ' : ''}${h.file}:${h.line}: ${h.text}`).join('\n');
    }

    return `未知 action: ${action}。可用：definition / references / symbols / diagnostics / hover。`;
  }
};

let _indexedOnce = false;
function usedIndex(cwd) {
  if (_indexedOnce) return;
  _indexedOnce = true;
  // 第一次查不到时把索引建起来，下次就快了（不阻塞本次返回）
  if (cwd) buildSymbolIndex(cwd);
}

export const lspTools = [lspTool];

export { rel as relPath };
