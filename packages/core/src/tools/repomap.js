// Repo map：用几百 token 换掉几十轮 glob + grep 的探索
//
// 与 context.js 的省 token 不同，这里是**主动**省：进仓库先生成一份符号骨架
// （只取函数/类/导出/常量的签名，不取函数体），模型一上来就知道这个仓库
// 有什么，而不是靠反复翻。
//
// 零依赖：正则提取（不引 tree-sitter）。准确率对"给模型一个索引"这个用途
// 足够 —— 它要的是"哪里有什么"，细节仍用 Read/Grep 精读。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveInRoots, cachedRoots } from '../security.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  'vendor', 'target', '__pycache__', '.venv', 'venv', 'env', '.cache', '.turbo',
  '.idea', '.vscode', '.gradle', 'Pods', '.tox', '.mypy_cache', '.pytest_cache',
  'tmp', 'temp', '.parcel-cache', 'storybook-static', '.svelte-kit'
]);

export { IGNORE_DIRS };

export const CODE_EXT = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.vue': 'js', '.svelte': 'js',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go', '.rs': 'rs', '.java': 'jvm', '.kt': 'jvm', '.kts': 'jvm',
  '.cs': 'jvm', '.scala': 'jvm', '.swift': 'other',
  '.rb': 'other', '.php': 'other', '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh',
  '.md': 'md', '.mdx': 'md'
};

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINES_SCANNED = 6000;

export function langOf(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return null;
  return CODE_EXT[name.slice(i).toLowerCase()] || null;
}

/** 遍历工作目录里的代码文件（符号索引 / 语义索引 / LSP 共用） */
export function walkCodeFiles(cwd, { maxFiles = 4000, maxBytes = MAX_FILE_BYTES } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 12 || out.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      const lang = langOf(e.name);
      if (!lang) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.size > maxBytes) continue;
      out.push({ path: full, lang, size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(cwd, 0);
  return out;
}

function push(list, kind, name) {
  if (!name) return;
  const clean = String(name).replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 80) return;
  list.push([kind, clean]);
}

/** 从一份源码里提取符号（返回 [kind, name][]） */
export function extractSymbols(text, lang) {
  const out = [];
  const lines = text.split('\n').slice(0, MAX_LINES_SCANNED);
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
    const top = line === line.trimStart(); // 顶层（顶格）
    if (lang === 'js') {
      let m;
      if ((m = /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line))) { push(out, 'fn', m[1]); continue; }
      if ((m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line)) && top) { push(out, 'fn', m[1]); continue; }
      if ((m = /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) { push(out, 'class', m[1]); continue; }
      if ((m = /^class\s+([A-Za-z_$][\w$]*)/.exec(line)) && top) { push(out, 'class', m[1]); continue; }
      if ((m = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/.exec(line))) {
        const isFn = /[:=]\s*(?:async\s*)?(?:function|\()/.test(line);
        push(out, isFn ? 'fn' : 'const', m[1]);
        continue;
      }
      if ((m = /^export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(line))) { push(out, 'type', m[1]); continue; }
      if ((m = /^export\s+\{\s*([^}]+)\}/.exec(line))) {
        for (const n of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())) push(out, 'export', n);
        continue;
      }
    } else if (lang === 'py') {
      let m;
      if ((m = /^(?:async\s+)?def\s+(\w+)/.exec(line)) && top) { push(out, 'fn', m[1]); continue; }
      if ((m = /^class\s+(\w+)/.exec(line)) && top) { push(out, 'class', m[1]); continue; }
    } else if (lang === 'go') {
      let m;
      if ((m = /^func\s+(?:\([^)]*\)\s*)?(\w+)/.exec(line))) { push(out, 'fn', m[1]); continue; }
      if ((m = /^type\s+(\w+)/.exec(line))) { push(out, 'type', m[1]); continue; }
    } else if (lang === 'rs') {
      let m;
      if ((m = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/.exec(line))) { push(out, 'fn', m[1]); continue; }
      if ((m = /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/.exec(line))) { push(out, 'type', m[1]); continue; }
    } else if (lang === 'jvm') {
      const m = /(?:^|\s)(?:public|private|protected|internal|abstract|final|static|open|sealed|data|\s)*\b(class|interface|enum|record|object|fun)\s+([A-Za-z_][\w]*)/.exec(line);
      if (m) push(out, m[1] === 'fun' ? 'fn' : 'class', m[2]);
      continue;
    } else if (lang === 'sh') {
      const m = /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)/.exec(line);
      if (m) push(out, 'fn', m[1]);
      continue;
    } else if (lang === 'md') {
      const m = /^(#{1,3})\s+(.+)$/.exec(line);
      if (m && out.length < 12) push(out, 'h', m[2].replace(/\s*#+\s*$/, ''));
      continue;
    }
  }
  // 去重（同名同 kind 只留一次）
  const seen = new Set();
  return out.filter(([k, n]) => {
    const key = `${k}:${n}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readIgnoreNames(cwd) {
  const names = new Set();
  for (const f of ['.gitignore', '.npmignore']) {
    try {
      const txt = readFileSync(join(cwd, f), 'utf8');
      for (const line of txt.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('!')) continue;
        const bare = t.replace(/^\//, '').replace(/\/$/, '');
        if (bare && !bare.includes('*') && !bare.includes('/')) names.add(bare);
      }
    } catch { /* 没有就没有 */ }
  }
  return names;
}

/** 收集代码文件（相对路径 + 大小 + mtime），受 maxFiles 限制 */
function collectFiles(cwd, { maxFiles = 800, extraIgnore = [] } = {}) {
  const ignoreNames = readIgnoreNames(cwd);
  for (const n of extraIgnore) ignoreNames.add(n);
  const files = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 10 || files.length >= maxFiles || visited > 20000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= maxFiles || visited > 20000) return;
      if (e.name.startsWith('.')) continue;
      if (IGNORE_DIRS.has(e.name) || ignoreNames.has(e.name)) continue;
      visited++;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      const lang = langOf(e.name);
      if (!lang) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.size > MAX_FILE_BYTES || st.size === 0) continue;
      files.push({ full, rel: relative(cwd, full).split(sep).join('/'), size: st.size, mtime: st.mtimeMs, lang });
    }
  };
  walk(cwd, 0);
  return files;
}

/**
 * 生成仓库骨架文本。
 * @returns {{text:string, files:number, symbols:number, truncated:boolean}}
 */
export function buildRepoMap(cwd, { maxChars = 3000, maxFiles = 800, maxSymbolsPerFile = 40 } = {}) {
  const files = collectFiles(cwd, { maxFiles });
  if (!files.length) return { text: '', files: 0, symbols: 0, truncated: false };

  const entries = [];
  let totalSymbols = 0;
  for (const f of files) {
    let text;
    try { text = readFileSync(f.full, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const syms = extractSymbols(text, f.lang).slice(0, maxSymbolsPerFile);
    if (!syms.length) continue;
    totalSymbols += syms.length;
    const byKind = new Map();
    for (const [kind, name] of syms) {
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(name);
    }
    entries.push({ ...f, byKind, count: syms.length });
  }
  if (!entries.length) return { text: '', files: files.length, symbols: 0, truncated: false };

  // 符号多的文件更"重要"（通常是核心模块）；同分按路径短优先
  entries.sort((a, b) => (b.count - a.count) || (a.rel.length - b.rel.length));

  const topDirs = [...new Set(files.map((f) => f.rel.split('/')[0]))].slice(0, 12);
  const header =
    `# 仓库骨架（自动生成，只有签名没有函数体；细节用 Read/Grep 精读）\n` +
    `# ${files.length} 个代码文件，${totalSymbols} 个符号；顶层：${topDirs.join(', ')}\n`;

  const lines = [header];
  let used = header.length;
  let truncated = false;
  for (const e of entries) {
    const parts = [];
    for (const [kind, names] of e.byKind) parts.push(`${kind}: ${names.join(', ')}`);
    const block = `${e.rel}\n  ${parts.join('\n  ')}\n`;
    if (used + block.length > maxChars) { truncated = true; break; }
    used += block.length;
    lines.push(block);
  }
  return { text: lines.join(''), files: files.length, symbols: totalSymbols, truncated };
}

// 同一仓库短时间内的多次调用直接复用（生成需要遍历目录，别每轮都跑）
const cache = new Map();
const CACHE_TTL = 20000;

export const repoMapTool = {
  name: 'RepoMap',
  description:
    '生成当前仓库的符号骨架（文件 → 函数/类/导出/常量的签名清单，不含函数体）。' +
    '开始探索一个陌生仓库时先用它，几百 token 就能知道"哪里有什么"，避免反复 glob/grep。',
  parameters: {
    type: 'object',
    properties: {
      max_chars: { type: 'number', description: '骨架文本上限字符数，默认 3000' },
      subdir: { type: 'string', description: '只扫描某个子目录（相对工作目录）' }
    }
  },
  async execute({ max_chars, subdir }, ctx) {
    const maxChars = Math.max(600, Math.min(Number(max_chars) || 3000, 20000));
    let root = ctx?.cwd;
    if (!root) return '工具不可用：未选择工作目录。';
    if (subdir && typeof subdir === 'string') {
      const r = resolveInRoots(subdir, ctx.sandboxRoots?.length ? ctx.sandboxRoots : cachedRoots(root));
      if (!r.ok) return r.reason;
      root = r.path;
    }
    const key = `${root}|${maxChars}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
    const { text, files, symbols, truncated } = buildRepoMap(root, { maxChars });
    const value = text
      ? `${text}${truncated ? `\n…（已达 ${maxChars} 字符上限，仅列出最重要的部分；可对子目录单独调用 RepoMap）` : ''}`
      : `未提取到符号（扫描了 ${files} 个文件）。可能是纯配置/资源仓库，改用 Glob / Grep。`;
    cache.set(key, { at: Date.now(), value });
    return value;
  }
};

export const repoMapTools = [repoMapTool];
