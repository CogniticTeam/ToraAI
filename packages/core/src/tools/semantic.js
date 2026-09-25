// 代码语义检索：本地倒排索引（零依赖、零网络）
//
// 和 Grep 的区别：Grep 匹配字面量，这里匹配**词**。
//  - `findUserById` 会被切成 find / user / by / id，所以搜「user find」也能命中；
//  - 中文注释按 bigram 切（搜「重试」能命中注释里的「失败重试」）；
//  - 定义行的权重高于普通引用行，所以搜一个名字时定义会排前面。
//
// 索引落盘 ~/.cocode/index/<rootHash>.inv.json，按 mtime+size 增量重建，
// 只在文件真的变了才重扫 —— 这就是「几毫秒换掉几十轮 grep」的来源。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { IGNORE_DIRS, langOf, walkCodeFiles } from './repomap.js';
import { extractDefinitions } from './lsp.js';
import { COCODE_DIR } from '../config.js';

const INDEX_DIR = join(COCODE_DIR, 'index');
const MAX_TOKENS = 200_000;
const MAX_POSTINGS_PER_TOKEN = 200;
const MAX_LINES_SCANNED = 8000;

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'not',
  'but', 'you', 'your', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default', 'class',
  'true', 'false', 'null', 'undefined', 'void', 'new', 'typeof', 'this', 'self',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try',
  'catch', 'finally', 'throw', 'async', 'await', 'yield', 'static', 'public', 'private'
]);

const CJK = /[\u4e00-\u9fa5]/;

/**
 * 切词：标识符按 camelCase / snake_case / kebab-case / 数字边界拆开，再补上原词。
 * 同时产出中文 bigram，让中文注释/查询也能命中。
 * @returns {string[]} 去重后的小写词
 */
export function tokenize(text) {
  const out = new Set();
  const s = String(text || '');
  // 英文/数字/下划线的词
  for (const w of s.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) || []) {
    if (w.length < 2) continue;
    const low = w.toLowerCase();
    if (!STOP.has(low)) out.add(low);
    // camelCase / PascalCase 拆分（连续大写视为缩写，如 XMLHttp）
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\-\s]+/)
      .filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) {
        const p2 = p.toLowerCase();
        if (p2.length >= 2 && !STOP.has(p2)) out.add(p2);
      }
    }
  }
  // 中文 bigram（不引入分词器，但足以让中文检索可用）
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

function rootHash(root) {
  return createHash('sha1').update(root).digest('hex').slice(0, 16);
}

function indexPath(root) {
  return join(INDEX_DIR, `${rootHash(root)}.inv.json`);
}

function readIndex(root) {
  const p = indexPath(root);
  if (!existsSync(p)) return null;
  try {
    const idx = JSON.parse(readFileSync(p, 'utf8'));
    if (idx?.version !== 1 || idx.root !== root) return null;
    return idx;
  } catch { return null; }
}

function writeIndex(root, idx) {
  try { mkdirSync(INDEX_DIR, { recursive: true }); } catch { /* ignore */ }
  try { writeFileSync(indexPath(root), JSON.stringify(idx)); } catch { /* 索引失败不该挡路 */ }
}

function rel(cwd, p) {
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

/** 单文件 → token 集合（整行文本一起切，保留行号） */
function indexFileText(text, lang) {
  const defLines = new Set(extractDefinitions(text, lang).map((d) => d.line));
  const lines = text.split('\n');
  const n = Math.min(lines.length, MAX_LINES_SCANNED);
  const perToken = new Map(); // token -> Set<line>
  const add = (tok, line) => {
    let s = perToken.get(tok);
    if (!s) { s = new Set(); perToken.set(tok, s); }
    if (s.size < 60) s.add(line);
  };
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const toks = tokenize(line);
    // 单行 token 太多（压缩过的代码/长数据）就跳过，避免索引被噪声淹没
    if (toks.length > 60) continue;
    for (const t of toks) add(t, i + 1);
  }
  return { perToken, defLines };
}

/**
 * 建立/增量更新倒排索引。
 * @returns {{ok:boolean,files:number,reused:number,tokens:number,reason?:string}}
 */
export function buildSemanticIndex(cwd, { force = false, maxFiles = 4000 } = {}) {
  if (!cwd) return { ok: false, files: 0, reused: 0, tokens: 0, reason: '未选择工作目录' };
  const prev = force ? null : readIndex(cwd);
  const walked = walkCodeFiles(cwd, { maxFiles });
  if (!walked.length) return { ok: true, files: 0, reused: 0, tokens: 0, reason: '没有可索引的源码文件' };

  const oldFiles = prev?.files || {};
  const oldTokens = prev?.tokens || {};
  const tokens = new Map();
  const files = {};
  let reused = 0;

  // 1) 先搬运未变文件已有的 postings，只重扫变化的文件
  const changed = new Set();
  for (const f of walked) {
    const key = rel(cwd, f.path);
    const o = oldFiles[key];
    files[key] = { mtime: f.mtime, size: f.size };
    if (o && o.mtime === f.mtime && o.size === f.size) { reused++; continue; }
    changed.add(key);
  }

  for (const [tok, postings] of Object.entries(oldTokens)) {
    const kept = postings.filter((p) => {
      const file = p.slice(0, p.lastIndexOf(':'));
      return !changed.has(file) && files[file];
    });
    if (kept.length) tokens.set(tok, kept);
  }

  // 2) 重扫变化的文件
  const defLinesByFile = new Map();
  for (const f of walked) {
    const key = rel(cwd, f.path);
    if (!changed.has(key)) continue;
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch { continue; }
    const { perToken, defLines } = indexFileText(text, f.lang);
    defLinesByFile.set(key, defLines);
    for (const [tok, lineSet] of perToken) {
      let arr = tokens.get(tok);
      if (!arr) { arr = []; tokens.set(tok, arr); }
      if (arr.length >= MAX_POSTINGS_PER_TOKEN) continue;
      for (const line of lineSet) arr.push(`${key}:${line}`);
    }
  }

  // 3) 控制体积：token 太多时丢掉最长的尾部（通常是最罕见的噪声词）
  let entries = [...tokens.entries()];
  if (entries.length > MAX_TOKENS) {
    entries.sort((a, b) => b[1].length - a[1].length);
    entries = entries.slice(0, MAX_TOKENS);
  }
  const obj = Object.fromEntries(entries.map(([k, v]) => [k, v.sort()]));
  // 定义行单独存一份，检索时给加权
  const defs = {};
  for (const [k, set] of defLinesByFile) defs[k] = [...set];

  writeIndex(cwd, { version: 1, root: cwd, builtAt: Date.now(), files, tokens: obj, defs });
  return { ok: true, files: walked.length, reused, tokens: entries.length };
}

/**
 * 检索：多词命中数排序，定义行加权。
 * @returns {{hits:Array, tokens:string[], candidates:number, indexed:boolean}}
 */
export function searchIndex(cwd, query, { limit = 20, path: sub = null } = {}) {
  if (!cwd || !String(query || '').trim()) return { hits: [], tokens: [], candidates: 0, indexed: false };
  let idx = readIndex(cwd);
  if (!idx) {
    buildSemanticIndex(cwd);
    idx = readIndex(cwd);
  }
  if (!idx) return { hits: [], tokens: [], candidates: 0, indexed: false };

  const qTokens = tokenize(query).slice(0, 12);
  if (!qTokens.length) return { hits: [], tokens: [], candidates: 0, indexed: true };

  // 权重：query 里的**整词**（decidepermission）比拆出来的子词（decide / permission）值钱得多。
  // 不加这一步，搜 decidePermission 会被满仓库的 "permission" 淹没。
  const strong = new Set((String(query).match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).map((w) => w.toLowerCase()));

  const score = new Map();   // "file:line" -> {hits, tokens:Set}
  for (const t of qTokens) {
    const postings = idx.tokens[t];
    if (!postings) continue;
    const w = strong.has(t) ? 3 : 1;
    for (const p of postings) {
      if (sub && !p.startsWith(sub.endsWith('/') ? sub : sub + '/')) continue;
      let s = score.get(p);
      if (!s) { s = { hits: 0, tokens: new Set() }; score.set(p, s); }
      s.hits += w;
      s.tokens.add(t);
    }
  }

  const defSet = new Set();
  for (const [file, lines] of Object.entries(idx.defs || {})) {
    if (sub && !file.startsWith(sub.endsWith('/') ? sub : sub + '/')) continue;
    for (const l of lines) defSet.add(`${file}:${l}`);
  }

  const hits = [];
  for (const [key, s] of score) {
    const cut = key.lastIndexOf(':');
    const file = key.slice(0, cut);
    const line = Number(key.slice(cut + 1));
    const isDef = defSet.has(key);
    // 命中权重为主，定义行 +2，覆盖 query 词越全的文件略微加成的
    const value = s.hits + (isDef ? 2 : 0) + (s.tokens.size / qTokens.length) * 0.5;
    hits.push({ file, line, score: value, matched: [...s.tokens], definition: isDef });
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);

  const top = hits.slice(0, limit);
  for (const h of top) {
    try {
      const abs = join(cwd, h.file);
      const text = readFileSync(abs, 'utf8').split('\n')[h.line - 1] || '';
      h.text = text.trim().slice(0, 200);
    } catch { h.text = ''; }
  }
  return { hits: top, tokens: qTokens, candidates: hits.length, indexed: true };
}

/** 索引统计（给 /admin/index 与调试用） */
export function indexStats(cwd) {
  const idx = readIndex(cwd);
  if (!idx) return { indexed: false };
  return { indexed: true, files: Object.keys(idx.files || {}).length, tokens: Object.keys(idx.tokens || {}).length, builtAt: idx.builtAt };
}

// ---------------------------------------------------------------- 工具

export const searchTool = {
  name: 'Search',
  description:
    '按词检索整个工作目录的代码（本地倒排索引，不联网）。与 Grep 不同：按词匹配（findUserById 会拆成 find/user/by/id），' +
    '中文注释按二字切分可用中文搜，定义行排在前面。适合「这个功能在哪个文件」。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词，可以是多个词、中英文混排' },
      path: { type: 'string', description: '限定子目录（相对工作目录）' },
      limit: { type: 'number', description: '结果条数，默认 20' }
    },
    required: ['query']
  },
  async execute(args = {}, ctx = {}) {
    const cwd = ctx.cwd;
    if (!cwd) return '未选择工作目录。';
    const query = String(args.query || '').trim();
    if (!query) return 'query 不能为空。';
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));

    let r = searchIndex(cwd, query, { limit, path: args.path || null });

    // 没建过索引 → 建一次再试
    if (!r.hits.length && r.indexed) {
      buildSemanticIndex(cwd, { force: true });
      r = searchIndex(cwd, query, { limit, path: args.path || null });
    }
    if (!r.hits.length) {
      return `没有命中「${query}」（索引词：${r.tokens.join(', ') || '无'}）。可以改用 Grep 做正则匹配，或换个更常见的词。`;
    }
    const head = `# 检索「${query}」→ ${r.candidates} 处命中，显示前 ${r.hits.length}（索引词：${r.tokens.join(', ')}）`;
    return head + '\n' + r.hits.map((h) => `  ${h.definition ? '★ ' : ''}${h.file}:${h.line}: ${h.text}`).join('\n');
  }
};

export const semanticTools = [searchTool];
