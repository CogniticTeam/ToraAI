// 内置工具实现（低 token 设计：范围读、限行数、截断输出）
//
// 命名：工具名统一 **PascalCase**（Bash / Read / Write / Edit / Glob / Grep…），
// 与 agentscope SDK 内建工具族和前端 tool-renderers 的映射表一致 —— 否则
// 7 个专用渲染器（含 DiffPreview）和每轮改动统计全部失效。旧会话里的
// snake_case 名字通过 canonicalToolName() 归一化，历史消息仍可正常渲染。
//
// 安全：所有文件路径都经 resolveInRoots() 限制在工作目录（及显式放行的根）内；
// bash 子进程不再继承完整 process.env（见 security.js）。
import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { relative, dirname } from 'node:path';
import { redact, resolveInRoots, cachedRoots } from '../security.js';
import { acquireShell, installShellExitHook, runOnce, releaseShell } from './shell.js';
import { gitIsWrite } from './git.js';
import { gitTools } from './git.js';
import { repoMapTools } from './repomap.js';
import { checkpointTools } from './checkpoint.js';
import { webTools } from './web.js';
import { browserTools, browserIsWrite } from './browser.js';
import { computerTools, computerIsWrite } from './computer.js';
import { taskTools } from './tasks.js';
import { memoryTools } from './memory.js';
import { lspTools } from './lsp.js';
import { semanticTools } from './semantic.js';

installShellExitHook();

// ---------------------------------------------------------------- 工具名归一

/** 旧名（snake_case）→ 规范名（PascalCase）。也接受全小写写法。 */
const ALIASES = {
  bash: 'Bash', shell: 'Bash', run: 'Bash',
  read: 'Read', readfile: 'Read', read_file: 'Read', cat: 'Read',
  write: 'Write', writefile: 'Write', write_file: 'Write',
  edit: 'Edit', editfile: 'Edit', edit_file: 'Edit', replace: 'Edit',
  glob: 'Glob', ls: 'Glob', list: 'Glob',
  grep: 'Grep', rg: 'Grep',
  // 注意：search 曾映射到 Grep（当时还没有语义检索工具）。现在有了真正的
  // Search（倒排索引按词匹配），search 归它更符合直觉，Grep 只留 grep/rg。
  search: 'Search', semantic_search: 'Search', code_search: 'Search',
  webfetch: 'WebFetch', web_fetch: 'WebFetch', fetch: 'WebFetch',
  websearch: 'WebSearch', web_search: 'WebSearch',
  git: 'Git', repomap: 'RepoMap', repo_map: 'RepoMap', repomap_tool: 'RepoMap',
  checkpoint: 'Checkpoint',
  lsp: 'Lsp', symbol: 'Lsp', symbols: 'Lsp', definition: 'Lsp', goto_definition: 'Lsp',
  find_references: 'Lsp', references: 'Lsp', diagnostics: 'Lsp', hover: 'Lsp',
  browser: 'Browser', browse: 'Browser', web_browser: 'Browser', webbrowser: 'Browser',
  computer: 'Computer', desktop: 'Computer', screen: 'Computer', mouse: 'Computer', keyboard: 'Computer'
};

export function canonicalToolName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return raw;
  if (ALIASES[raw]) return ALIASES[raw];
  return ALIASES[raw.toLowerCase()] || raw;
}

// ---------------------------------------------------------------- 工具分类

/** read / write / execute 三类的语义分类（权限决策用） */
export function toolCategory(name, args = {}) {
  switch (canonicalToolName(name)) {
    case 'Read': case 'Glob': case 'Grep': case 'WebFetch': case 'WebSearch': case 'RepoMap':
    case 'Lsp': case 'Search':
      return 'read';
    case 'Write': case 'Edit':
      return 'write';
    case 'Git':
      // git 子命令决定读还是写：status/diff/log 是读，commit/checkout 是写
      return gitIsWrite(String(args.subcommand ?? ''), args.args) ? 'write' : 'read';
    case 'Browser':
      // 导航算读、点击/输入算写（见 browserIsWrite 的说明）
      return browserIsWrite(String(args.action ?? '')) ? 'write' : 'read';
    case 'Computer':
      // 看屏幕算读；点/输/拖/滚/按键/动窗口都算写（见 computerIsWrite）
      return computerIsWrite(String(args.action ?? '')) ? 'write' : 'read';
    case 'Checkpoint':
      return args.action === 'restore' ? 'write' : 'read';
    case 'TaskCreate': case 'TaskUpdate':
      // 任务是会话状态里的持久写入（计划面板可见）
      return 'write';
    case 'TaskGet': case 'TaskList':
      return 'read';
    case 'MemorySave': case 'MemorySearch': case 'MemoryList': case 'MemoryForget':
      // 记忆工具只读写 ~/.vega/asapi/memories.json（用户记忆数据），不触碰
      // 工作区文件，归 write 会让默认权限模式每次弹确认卡，功能形同虚设；
      // 全归 read 放行。Forget 虽是删除，但删的是记忆不是文件，且指引限定
      // 只在用户明确要求时使用。
      return 'read';
    case 'AskUserQuestion':
      // 提问本身就是与用户交互，不该再被权限系统弹一张"确认卡"
      return 'read';
    // Team 工具族（队长权限层，默认 explore 模式下多数需要确认）
    case 'TeamCreate': case 'TeamDelete':
      return 'execute';
    case 'AgentCreate':
      return 'execute';
    case 'AgentRun': case 'AgentHandoff':
      return 'execute';
    case 'AgentMessage': case 'AgentList':
      return 'read';
    case 'TeamDocWrite':
      return 'write';
    case 'TeamDocRead':
      return 'read';
    case 'Bash':
      return 'execute';
    default:
      return 'execute';
  }
}

// ---------------------------------------------------------------- 通用

function truncate(s, limit) {
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.7);
  const tail = Math.floor(limit * 0.25);
  return `${s.slice(0, head)}\n…[输出过长，已截断 ${s.length - head - tail} 字符]…\n${s.slice(-tail)}`;
}

/** 统一路径解析：越界返回错误文本，调用方直接 return */
function safePath(p, ctx) {
  const roots = ctx?.sandboxRoots?.length
    ? ctx.sandboxRoots
    : cachedRoots(ctx?.cwd);
  return resolveInRoots(p, roots);
}

/**
 * 相对工作目录的展示路径。
 * 用真实根（sandboxRoots[0]）而不是 ctx.cwd 做基准 —— 后者可能是未
 * 归一化的路径（/var vs /private/var），直接 relative 会吐出
 * "../../../../private/var/..." 这种谁也不想看到的东西。
 */
const rel = (ctx, abs) => {
  const root = ctx?.sandboxRoots?.[0] || cachedRoots(ctx?.cwd)[0] || ctx?.cwd;
  if (!root) return abs;
  const r = relative(root, abs);
  return r && !r.startsWith('..') ? r : abs;
};

/** 给 Write / Edit 生成一份极简 diff，让"先看改动"这件事有据可依 */
export function miniDiff(oldText, newText, maxLines = 24) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const lines = [];
  const ctxLine = 2;
  for (let i = Math.max(0, start - ctxLine); i < start; i++) lines.push(`  ${a[i]}`);
  for (const l of removed.slice(0, maxLines)) lines.push(`- ${l}`);
  if (removed.length > maxLines) lines.push(`- …(共删除 ${removed.length} 行)`);
  for (const l of added.slice(0, maxLines)) lines.push(`+ ${l}`);
  if (added.length > maxLines) lines.push(`+ …(共新增 ${added.length} 行)`);
  return { diff: lines.join('\n'), added: added.length, removed: removed.length };
}

// 字符偏移 → 行号（0-based）：off[i] 是第 i 行的起始偏移
function lineOffsets(lines) {
  const off = [0];
  for (const l of lines) off.push(off[off.length - 1] + l.length + 1);
  return off;
}
function lineOf(off, pos) {
  let lo = 0, hi = off.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (off[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

/**
 * 标准 unified diff（进工具结果 metadata.diff，供前端渲染 diff 卡片和
 * 工具头部的 +N/-M 徽标；不给模型看 —— 模型侧仍用 miniDiff 的摘要，
 * 避免双份 diff 烧 token）。
 *
 * regions 可选（0-based 闭区间）：Edit replace_all 逐处出现传多个 hunk，
 * 行号两侧各自坐标（bStart 已含前面替换的行数漂移）；缺省时对全文
 * 首尾夹逼出单一区间（Write 覆盖 / Edit 单次替换）。
 * created=true 表示新文件：头用 /dev/null，纯 + 行。
 */
export function fileDiff(oldText, newText, path, regions, created = false) {
  const b = String(newText ?? '').split('\n');
  if (created) {
    return {
      diff: [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${b.length} @@`, ...b.map((l) => `+${l}`)].join('\n'),
      added: b.length, removed: 0
    };
  }
  const a = String(oldText ?? '').split('\n');
  if (!regions) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length - 1, endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
    regions = [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
  }
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  let added = 0, removed = 0;
  const CTX = 3;
  for (const r of regions) {
    const aLen = r.aEnd - r.aStart + 1;   // 空区间（纯插入）为 0
    const bLen = r.bEnd - r.bStart + 1;   // 空区间（纯删除）为 0
    added += bLen; removed += aLen;
    const pre = Math.max(0, r.aStart - CTX);
    const preCtx = r.aStart - pre;
    const postOld = Math.max(0, Math.min(CTX, a.length - (r.aEnd + 1)));
    const postNew = Math.max(0, Math.min(CTX, b.length - (r.bEnd + 1)));
    const oldCount = preCtx + aLen + postOld;
    const newCount = preCtx + bLen + postNew;
    const aNo = oldCount === 0 ? r.aStart : pre + 1;
    const bNo = newCount === 0 ? r.bStart - preCtx : r.bStart - preCtx + 1;
    lines.push(`@@ -${aNo},${oldCount} +${bNo},${newCount} @@`);
    for (let i = pre; i < r.aStart; i++) lines.push(` ${a[i]}`);
    for (let i = r.aStart; i <= r.aEnd; i++) lines.push(`-${a[i]}`);
    for (let i = r.bStart; i <= r.bEnd; i++) lines.push(`+${b[i]}`);
    for (let i = r.aEnd + 1; i <= r.aEnd + postOld; i++) lines.push(` ${a[i]}`);
  }
  return { diff: lines.join('\n'), added, removed };
}

// ---------------------------------------------------------------- Bash

/** 让 shell 命令的输出只保留最后一次 $PWD（持久 shell 下 cd 会保留） */
export const bashTool = {
  name: 'Bash',
  description:
    '在 shell 中执行命令。**持久会话**：同一次运行里的 cd / export / source venv/bin/activate 都会保留，' +
    '所以跨多步的构建流程可以直接连写。输出超限会截断。密钥类环境变量不会传进子进程。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout: { type: 'number', description: '超时毫秒数，默认 120000' },
      reset: { type: 'boolean', description: 'true = 放弃当前 shell 会话重新开始（清掉 cd/export 的残留）' }
    },
    required: ['command']
  },
  async execute({ command, timeout = 120000, reset = false }, ctx) {
    if (!ctx?.cwd) return '工具不可用：未选择工作目录。';
    const limit = ctx.toolOutputLimit ?? 6000;
    if (reset) releaseShell(ctx.cwd);

    const persistent = ctx.persistentShell !== false;
    let res;
    if (persistent) {
      const sh = acquireShell(ctx.cwd);
      if (sh) {
        res = await sh.run(command, timeout, ctx.signal);
        if (res.broken) {
          // shell 会话挂了 → 回退一次性执行，并让上层不再复用这条 shell
          releaseShell(ctx.cwd);
          res = await runOnce(command, ctx.cwd, timeout, ctx.signal);
        }
      } else {
        res = await runOnce(command, ctx.cwd, timeout, ctx.signal);
      }
    } else {
      res = await runOnce(command, ctx.cwd, timeout, ctx.signal);
    }

    // cd 会改变后续所有工具的工作目录（这是持久 shell 的核心价值）
    if (res.cwd && ctx.onCwdChange) ctx.onCwdChange(res.cwd);

    let out = `exit_code: ${res.exitCode}\n${res.output ?? ''}`;
    if (res.aborted) out = `命令已被用户中止。\n` + out;
    if (res.timedOut) out = `命令超时（${timeout}ms）已终止。\n` + out;
    if (res.truncated) out = '命令输出超过 200KB，已强制终止。\n' + out;
    return truncate(redact(out), limit);
  }
};

// ---------------------------------------------------------------- Read

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
};

/** 从文件头读图片尺寸（零依赖，覆盖 PNG/JPEG/GIF/WebP/BMP） */
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/bmp' && buf.length > 26) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (mime === 'image/webp' && buf.length > 30 && buf.toString('ascii', 12, 16) === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
  } catch { /* 解析失败就算了 */ }
  return null;
}

function extOf(p) {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}

export const readTool = {
  name: 'Read',
  description:
    '读取文件。文本文件带行号返回；大文件用 offset/limit 只读需要的范围。' +
    '图片（png/jpg/gif/webp/bmp）会以视觉输入方式提供给支持视觉的模型，同时返回尺寸等元信息。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录，或工作目录内的绝对路径）' },
      offset: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
      limit: { type: 'number', description: '读取行数，默认 300，最多 2000' }
    },
    required: ['path']
  },
  async execute({ path, offset = 1, limit = 300 }, ctx) {
    const r = safePath(path, ctx);
    if (!r.ok) return r.reason;
    const abs = r.path;
    let st;
    try { st = statSync(abs); } catch (e) { return `读取失败: ${e.message}`; }
    if (st.isDirectory()) {
      let entries;
      try { entries = readdirSync(abs).slice(0, 300); } catch (e) { return `读取失败: ${e.message}`; }
      return `这是一个目录，共 ${entries.length} 项：\n${entries.join('\n')}`;
    }

    // ---- 图片：给模型真正的视觉输入 ----
    const mime = IMAGE_MIME[extOf(abs)];
    if (mime) {
      const buf = readFileSync(abs);
      const size = imageSize(buf, mime);
      const dim = size ? `${size.width}×${size.height}` : '尺寸未知';
      const meta = `图片 ${rel(ctx, abs)}（${mime.replace('image/', '').toUpperCase()}，${dim}，${(st.size / 1024).toFixed(1)}KB）`;
      // 只有确认模型支持视觉时才附带图像内容，否则会 400
      if (ctx.vision === true) {
        return { text: `${meta}\n（已作为图像输入附上，可直接查看内容）`, image: { media_type: mime, data_url: `data:${mime};base64,${buf.toString('base64')}` } };
      }
      return `${meta}\n当前模型通道未启用视觉输入，只能看到上述元信息。如需"看图"，请在设置里为支持视觉的模型打开 vision。`;
    }

    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (e) {
      return `${rel(ctx, abs)} 看起来不是文本文件（${e.code || e.message}），且不是已支持的图片格式。请改用其他方式处理。`;
    }
    if (content.includes('\u0000')) {
      return `${rel(ctx, abs)} 是二进制文件（${(st.size / 1024).toFixed(1)}KB），无法按文本读取。`;
    }
    limit = Math.min(Math.max(1, limit), 2000);
    const lines = content.split('\n');
    const start = Math.max(1, offset | 0);
    const end = Math.min(lines.length, start - 1 + limit);
    const picked = [];
    for (let i = start - 1; i < end; i++) picked.push(`${i + 1}\t${lines[i]}`);
    let header = `${rel(ctx, abs)}（共 ${lines.length} 行）`;
    if (start > 1 || end < lines.length) header += `，本次读取 ${start}-${end} 行`;
    let body = picked.join('\n');
    if (body.length > ctx.toolOutputLimit) body = truncate(body, ctx.toolOutputLimit);
    return redact(header + '\n' + body);
  }
};

// ---------------------------------------------------------------- Write

export const writeTool = {
  name: 'Write',
  description: '写入文件（整体覆盖）。新文件或全量重写时使用；局部修改请用 Edit 以节省 token。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' }
    },
    required: ['path', 'content']
  },
  async execute({ path, content }, ctx) {
    const r = safePath(path, ctx);
    if (!r.ok) return r.reason;
    const abs = r.path;
    let before = null;
    try { before = readFileSync(abs, 'utf8'); } catch { /* 新文件 */ }
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    } catch (e) {
      return `写入失败: ${e.message}`;
    }
    const d = before == null
      ? { added: String(content).split('\n').length, removed: 0, diff: '' }
      : miniDiff(before, content);
    const head = before == null
      ? `已创建 ${rel(ctx, abs)}（${content.length} 字符，${d.added} 行）`
      : `已写入 ${rel(ctx, abs)}（+${d.added}/-${d.removed} 行，${content.length} 字符）`;
    // 标准 unified diff 给前端 UI（新文件纯 + 行；覆盖走首尾夹逼）；
    // text 仍带 miniDiff 摘要给模型。
    const u = fileDiff(before ?? '', content, rel(ctx, abs) || abs, null, before == null);
    return { text: d.diff ? `${head}\n${d.diff}` : head, meta: { diff: u.diff, added: u.added, removed: u.removed } };
  }
};

// ---------------------------------------------------------------- Edit

export const editTool = {
  name: 'Edit',
  description: '对文件做精确字符串替换（省 token 的局部修改方式）。old_string 必须与文件内容完全一致且唯一，除非 replace_all=true。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要替换的原文（含精确空白）' },
      new_string: { type: 'string', description: '替换后的内容' },
      replace_all: { type: 'boolean', description: '替换所有匹配（默认 false，仅替换且要求唯一）' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  async execute({ path, old_string, new_string, replace_all = false }, ctx) {
    const r = safePath(path, ctx);
    if (!r.ok) return r.reason;
    const abs = r.path;
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (e) {
      return `读取失败: ${e.message}`;
    }
    const count = content.split(old_string).length - 1;
    if (count === 0) return '未找到匹配的 old_string。请先用 Read 核对内容（注意空白与缩进）。';
    if (count > 1 && !replace_all) {
      return `old_string 出现 ${count} 次。请提供更长上下文使其唯一，或设 replace_all=true。`;
    }
    if (old_string === new_string) return 'old_string 与 new_string 相同，无需修改。';
    if (old_string === '') return 'old_string 不能为空。';
    const next = replace_all ? content.split(old_string).join(new_string)
      : content.replace(old_string, new_string);
    try {
      writeFileSync(abs, next);
    } catch (e) {
      return `写入失败: ${e.message}`;
    }
    const d = miniDiff(content, next);
    const head = `已修改 ${rel(ctx, abs)}（替换 ${replace_all ? count : 1} 处，+${d.added}/-${d.removed} 行）`;
    // 多 hunk unified diff：replace_all 时每处出现一个 hunk。
    // 逐出现定位 old 侧行区间，new 侧行号累加前面替换造成的行数漂移。
    const pathStr = rel(ctx, abs) || abs;
    const aLines = content.split('\n');
    const aOff = lineOffsets(aLines);
    const oldLn = old_string.split('\n').length;
    const newLn = new_string.split('\n').length;
    const regions = [];
    let scan = 0, delta = 0;
    for (;;) {
      const pos = content.indexOf(old_string, scan);
      if (pos < 0) break;
      const ls = lineOf(aOff, pos);
      regions.push({ aStart: ls, aEnd: ls + oldLn - 1, bStart: ls + delta, bEnd: ls + delta + newLn - 1 });
      delta += newLn - oldLn;
      scan = pos + Math.max(1, old_string.length);
    }
    const u = fileDiff(content, next, pathStr, regions);
    return { text: d.diff ? `${head}\n${d.diff}` : head, meta: { diff: u.diff, added: u.added, removed: u.removed } };
  }
};

// ---------------------------------------------------------------- Glob

function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '[\\s\\S]*'; i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

export const globTool = {
  name: 'Glob',
  description: '按通配符模式查找文件（如 src/**/*.js）。返回匹配路径列表（按修改时间排序）。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式' },
      path: { type: 'string', description: '搜索根目录，默认当前工作目录' }
    },
    required: ['pattern']
  },
  async execute({ pattern, path = '.' }, ctx) {
    const r = safePath(path, ctx);
    if (!r.ok) return r.reason;
    const root = r.path;
    const re = globToRegex(pattern.startsWith('/') ? pattern.slice(1) : pattern);
    const results = [];
    const walk = (dir, depth) => {
      if (depth > 12 || results.length > 500) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.git') continue;
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full, depth + 1);
        else if (re.test(relative(root, full)) || re.test(full)) {
          try { results.push({ p: full, m: statSync(full).mtimeMs }); } catch { /* skip */ }
        }
      }
    };
    let rootIsFile = false;
    try { rootIsFile = statSync(root).isFile(); } catch { /* ignore */ }
    if (rootIsFile) {
      results.push({ p: root, m: statSync(root).mtimeMs });
    } else {
      walk(root, 0);
    }
    results.sort((a, b) => b.m - a.m);
    if (!results.length) return `无匹配: ${pattern}`;
    return results.slice(0, 200).map((x) => rel(ctx, x.p) || x.p).join('\n') +
      (results.length > 200 ? `\n…共 ${results.length} 个匹配，仅显示前 200` : '');
  }
};

// ---------------------------------------------------------------- Grep

function buildRegex(pattern, ignoreCase) {
  try { return new RegExp(pattern, ignoreCase ? 'i' : ''); }
  catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : ''); }
}

export const grepTool = {
  name: 'Grep',
  description: '在文件内容中搜索正则表达式，返回匹配行（带行号）。优先用它定位，再配合 Read 精读。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索的文件或目录，默认当前工作目录' },
      glob: { type: 'string', description: '仅搜索匹配此 glob 的文件，如 *.js' },
      ignore_case: { type: 'boolean', description: '忽略大小写，默认 false' }
    },
    required: ['pattern']
  },
  async execute({ pattern, path = '.', glob, ignore_case = false }, ctx) {
    const r = safePath(path, ctx);
    if (!r.ok) return r.reason;
    const root = r.path;
    const re = buildRegex(pattern, ignore_case);
    const gRe = glob ? globToRegex(glob) : null;
    const results = [];
    const MAX = 200;
    const walk = (dir, depth) => {
      if (depth > 12 || results.length >= MAX * 5) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= MAX * 5) return;
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.git') continue;
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          if (gRe && !gRe.test(e.name)) continue;
          let content;
          try {
            const st = statSync(full);
            if (st.size > 2 * 1024 * 1024) continue;
            content = readFileSync(full, 'utf8');
          } catch { continue; }
          if (content.includes('\u0000')) continue;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              results.push(`${rel(ctx, full) || full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              if (results.length >= MAX) return;
            }
          }
        }
      }
    };
    try {
      if (statSync(root).isFile()) {
        const content = readFileSync(root, 'utf8');
        content.split('\n').forEach((line, i) => {
          if (re.test(line) && results.length < MAX) {
            results.push(`${rel(ctx, root) || root}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      } else walk(root, 0);
    } catch (e) {
      return `搜索失败: ${e.message}`;
    }
    if (!results.length) return `无匹配: ${pattern}`;
    return redact(results.join('\n') + (results.length >= MAX ? `\n…结果已达 ${MAX} 条上限` : ''));
  }
};

// ---------------------------------------------------------------- HITL 提问

/**
 * AskUserQuestion —— 让模型在运行中途向用户提选择题、拿回答案再继续。
 *
 * 执行经 ctx.askUser 通道：agent.js 把一条 emit(问题事件) → await resolver
 * 的闭包挂到 ctx 上（同 permissionAsk 的 HITL 范式）。没有该通道时（子代理 /
 * 无人值守）返回兜底提示，让模型自行判断而非干等。
 */
export const askUserTool = {
  name: 'AskUserQuestion',
  description:
    '向用户提问并等待其选择后继续。用于需求不明确、需要在几个方案里替用户拍板、' +
    '或需要补充关键信息时。一次可问 1-4 题，每题给 2-4 个互斥选项（label 简短、' +
    'description 说明取舍）；multiSelect=true 允许多选。不要把"其他"做成选项——' +
    '前端自带自由输入。拿不准默认值时优先问，而不是擅自假设。',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: '要问用户的问题（1-4 题）',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '完整问题，以问号结尾' },
            header: { type: 'string', description: '极短标签（≤12 字），显示为问题分类 chip' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              description: '候选项（2-4 个，互斥，除非 multiSelect）',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '选项显示文字（1-5 词）' },
                  description: { type: 'string', description: '该选项意味着什么 / 取舍' }
                },
                required: ['label', 'description']
              }
            },
            multiSelect: { type: 'boolean', description: 'true = 允许多选' }
          },
          required: ['question', 'header', 'options']
        }
      }
    },
    required: ['questions']
  },
  async execute({ questions }, ctx) {
    const ask = ctx?.askUser;
    if (typeof ask !== 'function') {
      return '当前运行环境没有用户交互通道（例如子代理或无人值守模式），无法向用户提问。请基于已知信息自行判断，或在结果里说明需要用户补充什么。';
    }
    const res = await ask({ questions: Array.isArray(questions) ? questions : [] });
    if (!res || res.cancelled) {
      return '用户取消了这个提问（未作答）。请基于已有信息继续，不要再就同一问题追问。';
    }
    // 把结构化答案排成模型好读的文本（题号 + 问题 + 所选/输入 + 补充信息）
    const lines = [];
    const qs = Array.isArray(questions) ? questions : [];
    for (let i = 0; i < qs.length; i++) {
      const a = res.answers?.[i];
      if (!a) continue;
      const picked = Array.isArray(a.selected) && a.selected.length ? a.selected.join('、') : '';
      const other = typeof a.other === 'string' && a.other.trim() ? a.other.trim() : '';
      const val = [picked, other].filter(Boolean).join('；') || '（跳过）';
      lines.push(`${i + 1}. ${qs[i]?.question ?? ''}\n   回答：${val}`);
    }
    if (res.note) lines.push(`补充信息：${res.note}`);
    return lines.length ? `用户回答：\n${lines.join('\n')}` : '用户提交了回答，但没有给出任何选择。';
  }
};

// ---------------------------------------------------------------- 汇总

// 其余工具各自独立成文件，这里做统一出口（顺序 = 呈现给模型的顺序）
export const coreFileTools = [bashTool, readTool, writeTool, editTool, globTool, grepTool];
export const hitlTools = [askUserTool];
export const builtinTools = [
  ...coreFileTools,
  ...webTools,
  ...gitTools,
  ...repoMapTools,
  ...checkpointTools,
  ...lspTools,
  ...semanticTools,
  ...browserTools,
  ...computerTools,
  ...taskTools,
  ...memoryTools,
  ...hitlTools
];
