// 每轮任务的可验证交付记录。只记录运行窗口内的文件指纹差异与实际工具证据，
// 不把既有脏改动冒充本轮产物，也不把建议执行的测试冒充已通过的测试。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { COCODE_DIR } from './config.js';
import { IGNORE_DIRS } from './tools/repomap.js';
import { readTrace } from './trace.js';

const DELIVERY_DIR = join(COCODE_DIR, 'deliveries');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CHANGED = 300;
const MAX_FILES = 8000;

function managedFiles(cwd) {
  const files = [];
  let limited = false;
  const walk = (dir, depth) => {
    if (depth > 12 || files.length >= MAX_FILES) { limited = true; return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) { limited = true; break; }
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 隐藏配置目录也可能是任务产物；只跳过依赖、缓存和 VCS 内部数据。
        if (entry.name.startsWith('.') && !['.github', '.cocode', '.vscode'].includes(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) files.push(full); // 不跟随符号链接
    }
  };
  walk(cwd, 0);
  return { files, limited };
}

function safeId(value) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(value || ''))) throw new Error('非法会话 ID');
  return String(value);
}

function snapshot(cwd) {
  const files = new Map();
  const seen = new Set();
  const warnings = [];
  const warningsEn = [];
  if (!cwd) return { files, seen, complete: false, warnings: ['未选择工作目录，无法比对文件。'], warningsEn: ['No workspace selected; files cannot be compared.'] };
  let bytes = 0;
  let skipped = 0;
  let limited = false;
  const managed = managedFiles(cwd);
  for (const file of managed.files) {
    seen.add(relative(cwd, file));
    try {
      const size = statSync(file).size;
      if (size > MAX_FILE_BYTES) { skipped++; continue; }
      if (bytes + size > MAX_TOTAL_BYTES) { limited = true; break; }
      files.set(relative(cwd, file), createHash('sha256').update(readFileSync(file)).digest('hex'));
      bytes += size;
    } catch { skipped++; }
  }
  if (limited) { warnings.push('文件扫描达到 64 MB 上限，改动清单可能不完整。'); warningsEn.push('The 64 MB scan limit was reached; the change list may be incomplete.'); }
  if (skipped) { warnings.push(`${skipped} 个文件因过大或无法读取而未参与比对。`); warningsEn.push(`${skipped} files were skipped because they were too large or unreadable.`); }
  if (managed.limited) { warnings.push('文件扫描达到文件数或目录深度上限，改动清单可能不完整。'); warningsEn.push('The file-count or directory-depth scan limit was reached; the change list may be incomplete.'); }
  return { files, seen, complete: !limited && !managed.limited, warnings, warningsEn };
}

function validationEvidence(trace) {
  if (!trace) return [];
  return trace.tools.flatMap((tool) => {
    if (tool.name !== 'Bash') return [];
    let command = '';
    try { command = JSON.parse(tool.args)?.command || ''; } catch { return []; }
    // 只识别明确的常见验证命令。复合 shell 片段不推断为独立测试结果。
    if (!/^(?:\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|check|build|typecheck)\b|\s*(?:npx\s+)?(?:vitest|jest|pytest|go\s+test|cargo\s+test|tsc\b|eslint\b|xcodebuild\b))/.test(command)) return [];
    if (/[;&|`]|\$\(/.test(command)) return [];
    const exit = /(?:^|\n)exit_code:\s*(-?\d+)/.exec(String(tool.result || ''));
    return [{ command: command.slice(0, 240), status: tool.blockedBy ? 'blocked' : tool.ok === false ? 'failed' : exit ? (Number(exit[1]) === 0 ? 'passed' : 'failed') : 'unknown', traceToolId: tool.id || null }];
  });
}

function modelReview(trace) {
  if (!trace) return null;
  const events = trace.events.filter((event) => event.event === 'review-result' || event.event === 'review-start');
  const last = events.at(-1);
  if (!last) return null;
  let data = {};
  try { data = JSON.parse(last.data); } catch { return null; }
  return {
    status: data.skipped ? 'skipped' : last.event === 'review-result' ? (data.passed ? 'passed' : 'failed') : 'unknown',
    round: Number(data.round) || 0,
    issues: Array.isArray(data.issues) ? data.issues.slice(0, 10).map(String) : [],
    reason: String(data.reason || '').slice(0, 300),
  };
}

/** 在 Agent 动手之前采集基线；用户在同一时段的编辑仍可能混入，报告会明确标注。 */
export function beginDelivery({ sessionId, cwd, traceId = null, modeEnabled = false, criteria = '' }) {
  safeId(sessionId);
  return { sessionId, cwd, traceId, modeEnabled, criteria: String(criteria).slice(0, 1200), startedAt: Date.now(), baseline: snapshot(cwd) };
}

/** 不影响 Agent 主流程；调用方在 trace.end 之后执行。 */
export function finishDelivery(context) {
  const after = snapshot(context.cwd);
  const before = context.baseline.files;
  const changedFiles = [];
  for (const [path, hash] of after.files) {
    if (before.has(path) && before.get(path) !== hash) changedFiles.push({ path, change: 'modified' });
    else if (context.baseline.complete && !context.baseline.seen.has(path)) changedFiles.push({ path, change: 'added' });
  }
  if (after.complete) for (const path of before.keys()) {
    if (!after.files.has(path) && !after.seen.has(path)) changedFiles.push({ path, change: 'deleted' });
  }
  changedFiles.sort((a, b) => a.path.localeCompare(b.path));
  const trace = context.traceId ? readTrace(context.traceId) : null;
  const checks = validationEvidence(trace);
  const warnings = [
    ...context.baseline.warnings,
    ...after.warnings,
    '改动仅表示本轮运行窗口内的文件差异；无法区分同时进行的人工或其他进程编辑。',
    '仅覆盖本轮开始时选定的工作目录；运行中切换到目录外的修改不在报告内。',
  ];
  const warningsEn = [
    ...context.baseline.warningsEn,
    ...after.warningsEn,
    'Changes are differences within the run window; concurrent edits by people or other processes cannot be attributed.',
    'Only the workspace selected at run start is covered; edits outside it after changing directories are not included.',
  ];
  if (!trace) { warnings.push('运行记录未启用或不可读取，无法核实执行过的验证命令。'); warningsEn.push('Run trace is disabled or unreadable, so executed checks cannot be verified.'); }
  if (!checks.length) { warnings.push('本轮未发现可核实的测试、构建或静态检查命令。'); warningsEn.push('No verifiable test, build, or static-check command was found in this run.'); }
  if (changedFiles.length > MAX_CHANGED) { warnings.push(`改动超过 ${MAX_CHANGED} 个文件，仅展示前 ${MAX_CHANGED} 个。`); warningsEn.push(`More than ${MAX_CHANGED} files changed; only the first ${MAX_CHANGED} are shown.`); }
  const report = {
    id: context.traceId?.split('/')[1] || `${context.startedAt}-${Math.random().toString(36).slice(2, 7)}`,
    sessionId: context.sessionId,
    traceId: context.traceId,
    cwd: context.cwd || null,
    startedAt: context.startedAt,
    finishedAt: Date.now(),
    outcome: trace?.end?.reason || 'unknown',
    modeEnabled: context.modeEnabled,
    criteria: context.criteria.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 12),
    changedFiles: changedFiles.slice(0, MAX_CHANGED),
    changedFileCount: changedFiles.length,
    checks,
    modelReview: modelReview(trace),
    warnings,
    warningsEn,
  };
  const dir = join(DELIVERY_DIR, safeId(context.sessionId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${report.id}.json`), JSON.stringify(report, null, 2));
  return report;
}

export function listDeliveries(sessionId, limit = 20) {
  const dir = join(DELIVERY_DIR, safeId(sessionId));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
    .map((name) => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 50));
}
