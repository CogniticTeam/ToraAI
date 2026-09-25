// 可观测性：把每一次运行摊开成一份可回放的 trace
//
// 为什么值得写盘：Agent 出问题时，用户看到的是「它瞎改了一通」，
// 而真正的原因往往是「第 3 轮上下文被压缩掉了关键约束」或「模型在没读文件的情况下
// 直接写了」。这些只有 trace 能还原。
//
// 落盘：~/.cocode/traces/<sessionId>/<runId>.jsonl（一行一个事件，追加写，
// 崩了也能看到崩溃前发生了什么）。
//
// 隐私：请求体默认只记**结构**（几条消息、多少字符、工具名单），不记正文；
// 打开 cfg.traceFullBody 才记全文，且所有文本都过一遍 redact()。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COCODE_DIR } from './config.js';
import { redact } from './security.js';

export const TRACES_DIR = join(COCODE_DIR, 'traces');
const MAX_JSONL_BYTES = 8 * 1024 * 1024; // 单个 trace 上限，超了就不再写（防止长跑把盘写满）
const PREVIEW = 600;

function ensureDir(d) {
  if (!existsSync(d)) { try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
}

function trim(s, n = PREVIEW) {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? null);
  if (t == null) return '';
  return t.length > n ? `${t.slice(0, n)}…[+${t.length - n}]` : t;
}

/** 结构化预览：保留 JSON 形状，但截断长度（trace 是给人看的，不是给程序解析的） */
function preview(obj, n) {
  return trim(obj, n);
}

function safeId(s) {
  return String(s || 'anon').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

/**
 * 创建一个 trace 记录器。
 * @param {{sessionId?:string, cwd?:string, model?:string, permissionMode?:string,
 *          mode?:string, cfg?:object, label?:string}} meta
 */
export function createTrace(meta = {}) {
  const cfg = meta.cfg || {};
  const enabled = cfg.traceEnabled !== false && !!meta.sessionId;
  const sessionId = safeId(meta.sessionId || 'anon');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const file = join(TRACES_DIR, sessionId, `${runId}.jsonl`);
  const startedAt = Date.now();
  let bytes = 0;
  let closed = false;
  const counters = { turns: 0, tools: 0, errors: 0 };

  if (enabled) {
    ensureDir(join(TRACES_DIR, sessionId));
    write({
      kind: 'run-start',
      meta: {
        cwd: meta.cwd || null,
        model: meta.model || null,
        permissionMode: meta.permissionMode || null,
        mode: meta.mode || null,
        label: meta.label || null,
        node: process.version,
        pid: process.pid
      }
    });
  }

  function write(obj) {
    if (!enabled || closed) return;
    const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
    if (bytes + line.length > MAX_JSONL_BYTES) return;
    try {
      appendFileSync(file, line);
      bytes += line.length;
    } catch { /* 观测失败绝不能影响主流程 */ }
  }

  return {
    enabled,
    path: enabled ? file : null,
    id: enabled ? `${sessionId}/${runId}` : null,

    /** 模型请求：默认只记结构 */
    request(turn, { messages, tools, wire }) {
      counters.turns = Math.max(counters.turns, turn);
      const body = cfg.traceFullBody === true
        ? {
            messages: messages.map((m) => ({
              role: m.role,
              content: Array.isArray(m.content)
                ? m.content.map((p) => (p.type === 'text' ? { type: 'text', text: trim(redact(p.text), 4000) } : { type: p.type }))
                : trim(redact(m.content), 4000),
              tool_calls: m.tool_calls?.map((tc) => ({ name: tc.function?.name, arguments: trim(tc.function?.arguments, 800) }))
            })),
            tools: wire
          }
        : {
            messageCount: messages.length,
            roles: messages.reduce((acc, m) => { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {}),
            chars: messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0),
            toolNames: Array.isArray(tools) ? tools.map((t) => t.function?.name) : []
          };
      const systemSample = typeof messages[0]?.content === 'string' ? trim(redact(messages[0].content), 800) : '';
      write({ kind: 'request', turn, body, systemSample });
    },

    /** 模型响应 */
    response(turn, { content, toolCalls, usage, durationMs, finishReason }) {
      write({
        kind: 'response',
        turn,
        durationMs,
        finishReason: finishReason || null,
        usage: usage || null,
        content: trim(redact(content || ''), 2000),
        toolCalls: (toolCalls || []).map((tc) => ({ name: tc.function?.name, arguments: trim(tc.function?.arguments, 800) }))
      });
    },

    /** 一次工具调用（含权限决策结果） */
    tool({ id, name, args, ok, durationMs, result, permission, blockedBy }) {
      counters.tools++;
      write({
        kind: 'tool',
        id,
        name,
        args: preview(redact(args ?? {}), 1500),
        ok,
        durationMs,
        permission: permission || null,
        blockedBy: blockedBy || null,
        result: trim(redact(String(result ?? '')), 1200)
      });
    },

    /** 钩子的执行结果 */
    hook({ event, ran, decision, reason, errors, notices }) {
      write({ kind: 'hook', event, ran, decision: decision || null, reason: trim(redact(reason || ''), 400), errors: (errors || []).slice(0, 5), notices: (notices || []).slice(0, 5) });
    },

    /** Agent 事件流里的关键事件（不记 text-delta，否则文件瞬间爆掉） */
    event(e) {
      if (!e || e.type === 'text-delta') return;
      if (e.type === 'error') counters.errors++;
      write({ kind: 'event', event: e.type, data: preview(redact(stripHeavy(e)), 1200) });
    },

    /** 收尾 */
    end(reason, extra = {}) {
      if (closed) return;
      write({ kind: 'run-end', reason, durationMs: Date.now() - startedAt, counters, ...extra });
      closed = true;
    }
  };
}

/** 事件里可能带很大的字段（工具结果），记录前削掉 */
function stripHeavy(e) {
  const out = { ...e };
  if (typeof out.result === 'string') out.result = trim(out.result, 300);
  if (Array.isArray(out.suggestedRules)) out.suggestedRules = out.suggestedRules.slice(0, 3);
  return out;
}

// ---------------------------------------------------------------- 读取 / 回放

function traceDir(sessionId) {
  return join(TRACES_DIR, safeId(sessionId));
}

function listFiles(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
}

/**
 * 列出 trace（可按会话过滤）。
 * @returns {Array<{id,sessionId,runId,startedAt,durationMs,size,turns,tools,reason,model,mode}>}
 */
export function listTraces({ sessionId = null, limit = 50 } = {}) {
  const out = [];
  const sessions = sessionId ? [safeId(sessionId)] : (() => {
    try { return readdirSync(TRACES_DIR).filter((d) => { try { return statSync(join(TRACES_DIR, d)).isDirectory(); } catch { return false; } }); }
    catch { return []; }
  })();
  for (const s of sessions) {
    const dir = join(TRACES_DIR, s);
    for (const f of listFiles(dir)) {
      const p = join(dir, f);
      let size = 0;
      try { size = statSync(p).size; } catch { continue; }
      const lines = readLines(p);
      const start = lines.find((l) => l.kind === 'run-start');
      const end = lines.find((l) => l.kind === 'run-end');
      out.push({
        id: `${s}/${f.replace(/\.jsonl$/, '')}`,
        sessionId: s,
        runId: f.replace(/\.jsonl$/, ''),
        path: p,
        size,
        startedAt: start?.ts ?? (lines[0]?.ts ?? 0),
        durationMs: end?.durationMs ?? null,
        reason: end?.reason ?? '（未正常结束）',
        turns: end?.counters?.turns ?? lines.filter((l) => l.kind === 'response').length,
        tools: end?.counters?.tools ?? lines.filter((l) => l.kind === 'tool').length,
        model: start?.meta?.model ?? null,
        mode: start?.meta?.mode ?? null
      });
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

function readLines(p) {
  let text;
  try { text = readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 崩溃时最后一行可能截断，跳过 */ }
  }
  return out;
}

/** 读取一次运行的全部记录 */
export function readTrace(id) {
  const [sessionId, runId] = String(id || '').split('/');
  if (!sessionId || !runId) return null;
  const p = join(traceDir(sessionId), `${safeId(runId)}.jsonl`);
  if (!existsSync(p)) return null;
  const lines = readLines(p);
  return {
    id,
    path: p,
    lines,
    start: lines.find((l) => l.kind === 'run-start') || null,
    end: lines.find((l) => l.kind === 'run-end') || null,
    turns: lines.filter((l) => l.kind === 'response'),
    tools: lines.filter((l) => l.kind === 'tool'),
    events: lines.filter((l) => l.kind === 'event'),
    hooks: lines.filter((l) => l.kind === 'hook')
  };
}

/** 把一次运行渲染成人能读的时间线（markdown） */
export function renderTrace(id, { maxToolResult = 300 } = {}) {
  const t = readTrace(id);
  if (!t) return `找不到 trace: ${id}`;
  const m = t.start?.meta || {};
  const lines = [];
  const secs = ((t.end?.durationMs ?? (Date.now() - (t.start?.ts || Date.now()))) / 1000).toFixed(1);
  lines.push(`# Trace ${id}`);
  lines.push(`模型 ${m.model || '?'} · 模式 ${m.mode || '?'} · 权限 ${m.permissionMode || '?'} · 目录 ${m.cwd || '(未选)'}`);
  lines.push(`时长 ${secs}s · 轮次 ${t.turns.length} · 工具 ${t.tools.length} · 结束原因 ${t.end?.reason || '（未正常结束）'}`);
  const usage = t.lines.filter((l) => l.kind === 'response' && l.usage)
    .reduce((a, l) => {
      a.prompt += l.usage.prompt_tokens || 0;
      a.completion += l.usage.completion_tokens || 0;
      a.cached += l.usage.cached_tokens || 0;
      return a;
    }, { prompt: 0, completion: 0, cached: 0 });
  const hit = usage.prompt ? Math.round((usage.cached / usage.prompt) * 100) : 0;
  lines.push(`Token：prompt ${usage.prompt} / completion ${usage.completion} / 命中缓存 ${usage.cached}（${hit}%）`);
  lines.push('');

  // 按发生顺序把 tool / event / hook 混进时间线
  const stream = t.lines.filter((l) => ['tool', 'event', 'hook'].includes(l.kind));
  const responses = t.turns;

  lines.push('## 时间线');
  let cursor = 0;
  for (const r of responses) {
    const dur = r.durationMs != null ? ` · ${r.durationMs}ms` : '';
    lines.push(`- **第 ${r.turn} 轮响应**${dur}`);
    if (r.content) lines.push(`  - 文本：${String(r.content).split('\n')[0].slice(0, 200)}`);
    for (const tc of r.toolCalls || []) lines.push(`  - 请求调用：\`${tc.name}\` ${tc.arguments || ''}`.slice(0, 300));
    // 该轮时间内发生的工具/事件
    const upto = r.ts;
    for (; cursor < stream.length && stream[cursor].ts <= upto; cursor++) {
      const s = stream[cursor];
      lines.push(formatStreamLine(s, maxToolResult));
    }
  }
  for (; cursor < stream.length; cursor++) lines.push(formatStreamLine(stream[cursor], maxToolResult));
  return lines.join('\n');
}

function formatStreamLine(s, maxToolResult) {
  if (s.kind === 'tool') {
    const perm = s.permission ? ` [${s.permission}]` : '';
    const blocked = s.blockedBy ? ` 被${s.blockedBy}拦下` : '';
    const head = `  - 🔧 \`${s.name}\`${perm}${blocked} ${s.ok ? '✓' : '✗'} ${s.durationMs ?? '?'}ms`;
    const res = s.result ? `\n    \`\`\`\n    ${String(s.result).slice(0, maxToolResult)}\n    \`\`\`` : '';
    return head + res;
  }
  if (s.kind === 'hook') {
    return `  - 🪝 ${s.event} 跑了 ${s.ran} 个${s.decision ? ` → ${s.decision}` : ''}${s.reason ? `（${s.reason}）` : ''}`;
  }
  return `  - • ${s.event}${s.data?.reason ? `: ${s.data.reason}` : s.data?.turn != null ? ` turn=${s.data.turn}` : ''}`;
}

/** 清理旧 trace（默认保留 7 天） */
export function gcTraces({ keepDays = 7 } = {}) {
  let removed = 0;
  const cutoff = Date.now() - keepDays * 86400_000;
  const sessions = (() => { try { return readdirSync(TRACES_DIR); } catch { return []; } })();
  for (const s of sessions) {
    const dir = join(TRACES_DIR, s);
    for (const f of listFiles(dir)) {
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) { rmSync(p, { force: true }); removed++; }
      } catch { /* ignore */ }
    }
  }
  return { removed };
}

/** 统计（给 /admin/traces 概览用） */
export function traceStats() {
  const all = listTraces({ limit: 1000 });
  const tokens = all.reduce((a, t) => { a.tools += t.tools || 0; a.turns += t.turns || 0; return a; }, { tools: 0, turns: 0 });
  return { runs: all.length, ...tokens, latest: all[0]?.startedAt ?? null };
}
