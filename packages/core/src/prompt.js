// 项目指令文件 + 系统提示词装配
//
// 问题：原来 SYSTEM_PROMPT 是 model.js 里写死的英文常量，所有项目共用一份 ——
// 模型进任何仓库都不知道该仓库的约定、构建命令、目录结构。
//
// 现在：每次运行都会去工作目录找约定文件（TORA.md / AGENTS.md / CLAUDE.md …），
// 连同 Git 状态与仓库骨架一起拼进系统提示词。系统提示词是稳定前缀，
// 对支持上下文缓存的厂商（DeepSeek / 智谱等）是缓存友好的位置。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { buildRepoMap, walkCodeFiles } from './tools/repomap.js';
import { readGitInfo } from './tools/git.js';

/** 同一目录中的约定文件优先级；不同层级从仓库根目录到 cwd 叠加。 */
export const INSTRUCTION_FILES = [
  'TORA.md',
  'COCODE.md', // 已有项目约定保持可读。
  'AGENTS.md',
  '.tora/AGENTS.md',
  '.cocode/AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md'
];

export const DEFAULT_INSTRUCTION_MAX_CHARS = 6000;

const cache = new Map(); // path -> { mtime, text }

function instructionDirectories(cwd) {
  const current = resolve(cwd);
  let root = current;
  for (let dir = current; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) { root = dir; break; }
    if (dirname(dir) === dir) break;
  }
  const dirs = [];
  for (let dir = current; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === root) break;
  }
  return dirs.reverse();
}

/**
 * 读取项目约定文件。
 * @returns {{file:string, text:string, truncated:boolean, sources:Array}|null}
 */
export function loadProjectInstructions(cwd, { maxChars = DEFAULT_INSTRUCTION_MAX_CHARS, maxTotalChars = 12000 } = {}) {
  if (!cwd) return null;
  const sources = [];
  for (const dir of instructionDirectories(cwd)) {
    for (const name of INSTRUCTION_FILES) {
      const full = join(dir, name);
      if (!existsSync(full)) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      let text;
      const hit = cache.get(full);
      if (hit && hit.mtime === st.mtimeMs) {
        text = hit.text;
      } else {
        try { text = readFileSync(full, 'utf8'); } catch { continue; }
        cache.set(full, { mtime: st.mtimeMs, text });
      }
      sources.push({ file: relative(resolve(cwd), full) || name, text: text.slice(0, maxChars), truncated: text.length > maxChars });
      break;
    }
  }
  if (!sources.length) return null;
  // 预算不足时优先保留更靠近当前目录的约定，最后仍按根到子目录排列。
  let remaining = Math.max(1, maxTotalChars);
  const kept = sources.slice().reverse().map((source) => {
    const text = source.text.slice(0, remaining);
    remaining -= text.length;
    return { ...source, text, truncated: source.truncated || text.length < source.text.length };
  }).reverse().filter((source) => source.text);
  return {
    file: kept.map((source) => source.file).join(' → '),
    text: kept.map((source) => `## ${source.file}${source.truncated ? '（已截断）' : ''}\n${source.text}`).join('\n\n'),
    truncated: kept.some((source) => source.truncated),
    sources: kept
  };
}

/**
 * 仓库骨架注入：只在"值得"的时候注入 —— 小仓库让模型自己 Glob 更便宜，
 * 大仓库才用骨架换探索轮数。阈值可配。
 */
export function shouldInjectRepoMap({ fileCount, codeFileCount, threshold = 25 }) {
  return (codeFileCount ?? fileCount ?? 0) >= threshold;
}

/**
 * 探测工作目录的上下文（约定文件 + git 状态 + repo map）。
 * 三者都 best-effort：任何一步失败都不影响主流程。
 */
export async function loadProjectContext(cwd, cfg = {}) {
  const out = { instructions: null, git: null, repoMap: '', changes: null };
  if (!cwd) return out;
  try {
    out.instructions = loadProjectInstructions(cwd, { maxChars: cfg.instructionMaxChars });
  } catch { /* ignore */ }
  try {
    out.git = await readGitInfo(cwd);
  } catch { /* ignore */ }
  if (cfg.changesAware !== false) {
    try {
      out.changes = recentChanges(cwd, out.git, { limit: cfg.changesLimit ?? 12 });
    } catch { /* ignore */ }
  }
  if (cfg.repoMapInject !== false) {
    try {
      const map = buildRepoMap(cwd, { maxChars: cfg.repoMapMaxChars ?? 2500 });
      if (shouldInjectRepoMap({ fileCount: map.files }, cfg.repoMapThreshold ?? 25)) {
        out.repoMap = map.text;
      }
    } catch { /* ignore */ }
  }
  return out;
}

/** 把项目上下文渲染成系统提示词的一段 */
export function renderProjectContext({ instructions, git, repoMap, changes }) {
  const parts = [];
  if (instructions) {
    parts.push(
      `# 项目约定（来源：${instructions.file}${instructions.truncated ? '；部分已截断' : ''}）\n` +
      `以下内容由仓库作者维护，优先级高于你的默认习惯，请严格遵守：\n\n${instructions.text.trim()}`
    );
  }
  if (git?.is_repo) {
    const bits = [`分支 ${git.branch ?? '(detached)'}`];
    if (git.dirty) bits.push(`${git.dirty} 个文件有改动`);
    if (git.ahead) bits.push(`领先远端 ${git.ahead}`);
    if (git.behind) bits.push(`落后远端 ${git.behind}`);
    parts.push(`# 仓库状态\n${bits.join('，')}。改动前先用 Git 看 diff，改完可以用 Git 提交或回滚。`);
  }
  if (changes?.length) {
    const dirty = git?.dirty_files || [];
    const lines = changes.map((c) => `  ${c.dirty ? '*' : ' '} ${c.file}（${c.ago}）`);
    parts.push(
      `# 最近改动\n带 * 的是还没提交的（git 里的脏文件），其余按修改时间排序。\n` +
      `改动前先看这些文件的当前内容，不要假设它们还是你记忆里的样子。\n${lines.join('\n')}` +
      (dirty.length > changes.filter((c) => c.dirty).length ? `\n（另有 ${dirty.length} 个脏文件未列出）` : '')
    );
  }
  if (repoMap) {
    parts.push(
      `# 仓库骨架（自动生成，只有签名没有函数体；需要细节用 Read / Grep，需要最新版可再调 RepoMap）\n${repoMap.trim()}`
    );
  }
  return parts.join('\n\n');
}

function humanAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return d === 1 ? '昨天' : `${d} 天前`;
}

/**
 * 变更感知上下文：把「哪些文件刚被动过」摆到模型面前。
 * 为什么需要：模型对仓库的印象来自训练数据与本次对话，而磁盘上的文件可能
 * 已经变了（用户手改、上一个会话改的、git checkout 换过分支）。不告诉它，
 * 它就会信心十足地基于旧印象改代码。
 */
export function recentChanges(cwd, git, { limit = 12 } = {}) {
  if (!cwd) return null;
  const dirtySet = new Set(git?.dirty_files || []);
  const rows = [];
  const seen = new Set();
  for (const f of walkCodeFiles(cwd, { maxFiles: 3000 })) {
    const r = relative(cwd, f.path).split(sep).join('/');
    if (seen.has(r)) continue;
    seen.add(r);
    rows.push({ file: r, mtime: f.mtime, dirty: dirtySet.has(r) });
  }
  // 脏文件一定进（它们是「正在写的东西」），其余按 mtime 排
  const dirty = rows.filter((r) => r.dirty).slice(0, limit);
  const rest = rows.filter((r) => !r.dirty).sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(0, limit - dirty.length));
  const now = Date.now();
  const out = [...dirty, ...rest].map((r) => ({ file: r.file, dirty: r.dirty, ago: humanAgo(Math.max(0, now - r.mtime)) }));
  return out.length ? out : null;
}

/**
 * 装配本次运行的系统提示词：基础提示词 + 项目上下文（+ ReAct 模式说明）。
 * @param {object} opts
 * @param {string} opts.basePrompt  用户/内置的基础提示词
 * @param {object} opts.projectContext  loadProjectContext() 的结果
 * @param {boolean} [opts.reactMode]  模型不支持 tool_calls 时追加文本 ReAct 协议
 * @param {string[]} [opts.toolNames] ReAct 模式下把可用工具名列出来
 */
export function buildSystemPrompt({ basePrompt, projectContext, reactMode = false, toolNames = [], hookContext = '' }) {
  const parts = [String(basePrompt || '').trim()];
  if(toolNames.includes('WebPreview'))parts.push('网页交付：创建或修改 HTML、官网、网页应用后，主动准备本地预览。独立 HTML 用 WebPreview 的 path 启动本地静态服务器；Vite、Next 等框架先按项目文档用 Bash 启动开发服务器（仅监听本机），确认页面就绪后用 WebPreview 的 url 登记。不要把需要构建的源码当成可用网页。完成回复时保留预览服务器，Tora 会提供内置浏览器打开卡片。');
  const ctxText = projectContext ? renderProjectContext(projectContext) : '';
  if (ctxText) parts.push(ctxText);
  if (hookContext) {
    parts.push(`# 来自用户钩子的上下文（UserPromptSubmit）\n${String(hookContext).trim()}`);
  }
  if (reactMode) {
    parts.push(toolNames.length
      ? `${REACT_PROTOCOL}\n   ${toolNames.join(', ')}\n6. args 里的参数名也必须严格照抄工具定义（先用一次 \`{"tool":"RepoMap","args":{}}\` 或直接按常识写；写错会得到参数错误提示）。`
      : REACT_PROTOCOL);
  }
  return parts.filter(Boolean).join('\n\n---\n\n');
}

/** 文本 ReAct 协议：给不支持 tool_calls 的模型用的降级说明 */
export const REACT_PROTOCOL = `# 工具调用协议（文本模式）
当前接入的模型不支持原生 function calling，请用**文本动作块**代替。规则：
1. 需要调用工具时，**只输出**一个 \`\`\`json 代码块，内容形如
   {"tool": "Read", "args": {"path": "src/a.js"}}
   不要在同一条回复里既解释又调用；调用前的说明写在代码块之前的正文里。
2. 每次回复最多调用**一个**工具。
3. 收到工具结果后继续思考，直到可以给出最终答复。
4. 完成时输出 \`\`\`json 代码块 {"final": "给用户的最终答复"}，或直接输出正文（无代码块时按最终答复处理）。
5. 工具名必须是下列之一，参数名严格照抄：`;

// 兜底清单（正常情况下由 runAgent 传入真实工具名，见 buildSystemPrompt 的 toolNames）
export const AVAILABLE_TOOL_NAMES = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Git', 'RepoMap', 'Checkpoint', 'Lsp', 'Search'
];
