#!/usr/bin/env node
// 在全新临时工作区运行同一批小型工程任务；评分只看独立验收，不听 Agent 自报完成。
import { parseArgs } from 'node:util';
import { cpSync, readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { redact, registerSecret } from '../packages/core/src/security.js';
import { gradeQuixBugs, loadQuixBugs } from './eval-suite/quixbugs.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    'check-fixtures': { type: 'boolean' },
    'model-from-config': { type: 'boolean' },
    'runner-kind': { type: 'string' },
    runner: { type: 'string' },
    name: { type: 'string' },
    task: { type: 'string' },
    'output-dir': { type: 'string' },
    'timeout-ms': { type: 'string' },
    'model-label': { type: 'string' },
    dataset: { type: 'string' },
    'dataset-dir': { type: 'string' },
    'dataset-revision': { type: 'string' },
    python: { type: 'string' },
    help: { type: 'boolean' },
  },
});

if (values.help || (!values['check-fixtures'] && !values.runner)) {
  console.log('用法：node scripts/eval-work-execution.mjs --check-fixtures');
  console.log('      node scripts/eval-work-execution.mjs --name Tora --runner \'["node","/绝对路径/Tora/packages/cli/src/index.js","{prompt}"]\'');
  console.log('runner 是 JSON 数组；{prompt} 会替换成任务描述，未写占位符时追加在参数末尾。');
  console.log('--runner-kind tora|tora-desktop|codex|claude-code|dsh');
  console.log('--dataset quixbugs --dataset-dir <checkout> --dataset-revision <sha> --python <pytest interpreter>');
  process.exit(values.help ? 0 : 2);
}

const timeoutMs = values['timeout-ms'] ? Number(values['timeout-ms']) : 240_000;
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error('timeout-ms 必须在 1000–600000 之间');
let runner = null;
if (values.runner) {
  runner = JSON.parse(values.runner);
  if (!Array.isArray(runner) || !runner.length || runner.some((arg) => typeof arg !== 'string' || !arg)) {
    throw new Error('runner 必须是非空字符串数组');
  }
}
const name = String(values.name || 'Agent').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
const runnerKind = values['runner-kind'] || 'tora';
if (!['tora', 'tora-desktop', 'codex', 'claude-code', 'dsh'].includes(runnerKind)) throw new Error('未知 runner-kind');
if (values.dataset && values.dataset !== 'quixbugs') throw new Error('未知评测数据集');
const publicSuite = values.dataset ? loadQuixBugs(values['dataset-dir'], values['dataset-revision'], values.python) : null;
const allTasks = publicSuite?.tasks ?? JSON.parse(readFileSync(new URL('./eval-suite/tasks.json', import.meta.url), 'utf8'));
const tasks = values.task ? allTasks.filter((task) => task.id === values.task) : allTasks;
if (!tasks.length) throw new Error(`未知任务：${values.task}`);
let modelEnv = {};
let model = values['model-label'] || null;
if (values['model-from-config']) {
  const { loadConfig } = await import('../packages/core/src/config.js');
  const cfg = loadConfig();
  if (String(cfg.baseURL || '').includes('/official/v1')) {
    console.error('评测配置错误：当前配置指向仅供桌面会话使用的官方模型网关；CLI 评测需先配置自接入的 OpenAI 兼容模型');
    process.exit(2);
  }
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseURL || '')) throw new Error('现有配置没有可用模型凭证');
  model = cfg.model;
  if (['dsh', 'claude-code', 'codex'].includes(runnerKind)) {
    const url = new URL(cfg.baseURL);
    if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || cfg.model !== 'deepseek-flash' || !cfg.apiKey) {
      throw new Error('此同模型评测需要现有配置使用 DeepSeek 官方 deepseek-flash 和有效凭证');
    }
    // CLI runners consume the same DeepSeek credential through their provider adapters.
    modelEnv = runnerKind !== 'claude-code' ? { DEEPSEEK_API_KEY: cfg.apiKey } : {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
      ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_MODEL: cfg.model, ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.model,
      CLAUDE_CODE_SUBAGENT_MODEL: cfg.model, CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
  } else {
    modelEnv = { TORA_BASE_URL: cfg.baseURL, TORA_API_KEY: cfg.apiKey, TORA_MODEL: cfg.model, TORA_EVAL_PROVIDER: cfg.provider || '' };
  }
}
for (const key of [modelEnv.TORA_API_KEY, modelEnv.DEEPSEEK_API_KEY, modelEnv.ANTHROPIC_AUTH_TOKEN, process.env.TORA_API_KEY,
  process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.CLAUDE_CODE_OAUTH_TOKEN]) registerSecret(key);

function seed(task, workspace) {
  for (const [relative, content] of Object.entries(task.files)) {
    if (!/^[-\w.]+(?:\/[-\w.]+)*$/.test(relative) || relative.split('/').some(part => part === '.' || part === '..')) throw new Error(`非法 fixture 路径：${relative}`);
    const dest = join(workspace, relative);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}

function validateFixture(task, workspace) {
  // Generated modules run in a separate process without the runner's model credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TMPDIR|TEMP|TMP|LANG|LC_\w+|TZ)$/i.test(name)));
  if (publicSuite) return gradeQuixBugs(task, workspace, publicSuite.python, env);
  const validator = fileURLToPath(new URL('./eval-suite/validators.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [validator, task.id], {
    cwd: workspace, env, encoding: 'utf8', timeout: 35_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`验收进程失败：${result.error?.code || result.signal || result.status}`);
  }
  const error = result.status === 0 && result.stdout.trimEnd().endsWith('\nTORA_EVAL_PASSED') ? null
    : redact(String(result.stderr || '验收失败').trim()).slice(0, 800);
  return { error };
}

function initialFailure(task, workspace) {
  const initial = validateFixture(task, workspace);
  if (!initial.error || (publicSuite && !initial.tests?.failed)) throw new Error(`${task.id} 初始状态未产生预期的测试失败`);
  return initial;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function counters(value, fields) {
  if (!isRecord(value)) return null;
  return Object.fromEntries(fields.map((field) => [field, Number.isSafeInteger(value[field]) && value[field] >= 0 ? value[field] : null]));
}

const unknown = { finishReason: null, metrics: null, totalUsage: null };
const validCounter = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function readProviderTrace(stdout) {
  const events = stdout.split('\n').flatMap(line => {
    try { const event = JSON.parse(line); return isRecord(event) ? [event] : []; }
    catch { return []; }
  });
  if (runnerKind === 'codex') {
    const final = events.findLast(event => ['turn.completed', 'turn.failed'].includes(event.type));
    if (!final) return unknown;
    const kinds = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'dynamic_tool_call', 'web_search']);
    const tools = events.filter(event => event.type === 'item.completed' && kinds.has(event.item?.type));
    const usage = final.usage;
    return {
      finishReason: final.type === 'turn.completed' ? 'completed' : 'error',
      metrics: { toolCalls: tools.length, failedToolCalls: tools.filter(event => event.item.status === 'failed').length },
      totalUsage: usage ? {
        prompt_tokens: validCounter(usage.input_tokens), completion_tokens: validCounter(usage.output_tokens),
        cached_tokens: validCounter(usage.cached_input_tokens),
      } : null,
    };
  }
  const final = events.findLast(event => event.type === 'result');
  if (!final) return unknown;
  const usage = final.usage;
  const input = validCounter(usage?.input_tokens);
  const tools = new Set(events.flatMap(event => event.type === 'assistant' && Array.isArray(event.message?.content)
    ? event.message.content.filter(part => part.type === 'tool_use' && typeof part.id === 'string').map(part => part.id)
    : []));
  return {
    finishReason: final.subtype === 'success' && !final.is_error ? 'completed' : 'error',
    metrics: { actionTurns: validCounter(final.num_turns), toolCalls: tools.size,
      deniedToolCalls: Array.isArray(final.permission_denials) ? final.permission_denials.length : null },
    totalUsage: usage ? {
      prompt_tokens: input === null ? null : input + (validCounter(usage.cache_creation_input_tokens) ?? 0) + (validCounter(usage.cache_read_input_tokens) ?? 0),
      completion_tokens: validCounter(usage.output_tokens), cached_tokens: validCounter(usage.cache_read_input_tokens),
    } : null,
  };
}

function readRunSummary(taskDir, stdout) {
  if (runnerKind === 'codex' || runnerKind === 'claude-code') return readProviderTrace(stdout);
  if (runnerKind !== 'tora' && runnerKind !== 'tora-desktop') return unknown;
  const desktop = runnerKind === 'tora-desktop';
  const sessions = join(taskDir, 'agent-state', ...(desktop ? ['asapi', 'sessions'] : ['sessions']));
  let session;
  try {
    const files = readdirSync(sessions, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    // Multiple sessions make telemetry ambiguous; never infer it from messages or logs.
    if (files.length !== 1) return unknown;
    session = JSON.parse(readFileSync(join(sessions, files[0].name), 'utf8'));
  } catch {
    // Missing, unreadable, or malformed optional telemetry is not a task score.
    return unknown;
  }
  const run = desktop ? session?.display?.at(-1)?.metadata?.harness : session?.lastRun;
  if (!isRecord(run) || !['completed', 'aborted', 'max-turns', 'blocked', 'error'].includes(run.reason)) return unknown;
  const metrics = counters(run.metrics, ['actionTurns', 'modelCalls', 'toolCalls', 'failedToolCalls', 'deniedToolCalls', 'compactions',
    'usageReportedCalls', ...(desktop ? ['firstRequestTools', 'firstToolTokens', 'verificationRepairs',
      'elapsedMs', 'modelWaitMs', 'toolBatchMs'] : [])]);
  const totalUsage = metrics?.usageReportedCalls > 0 ? counters(run.totalUsage, ['prompt_tokens', 'completion_tokens', 'cached_tokens']) : null;
  return { finishReason: run.reason, metrics, totalUsage };
}

async function main() {
  if (values['check-fixtures']) {
    for (const task of tasks) {
      const workspace = mkdtempSync(join(tmpdir(), 'tora-eval-fixture-'));
      try { seed(task, workspace); initialFailure(task, workspace); console.log(`✓ ${task.id}：初始状态未通过验收`); }
      finally { rmSync(workspace, { recursive: true, force: true }); }
    }
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputBase = values['output-dir'] ? resolve(values['output-dir']) : resolve(project, 'output', 'agent-eval');
  const runDir = join(outputBase, `${stamp}-${name}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const results = [];
  for (const task of tasks) {
    const taskDir = join(runDir, task.id);
    mkdirSync(taskDir, { recursive: true });
    // Keep repository context out of fixtures; a temporary directory is not an OS sandbox.
    const workspace = mkdtempSync(join(tmpdir(), `tora-eval-${task.id}-`));
    try {
      seed(task, workspace);
      const initial = initialFailure(task, workspace);
      const args = runner.slice(1).map((arg) => arg.replaceAll('{prompt}', task.prompt));
      if (!runner.slice(1).some((arg) => arg.includes('{prompt}'))) args.push(task.prompt);
      const start = Date.now();
      const child = spawnSync(runner[0], args, {
        cwd: workspace,
        env: {
          ...process.env, ...modelEnv,
          ...(publicSuite ? {
            PATH: `${dirname(publicSuite.python)}${delimiter}${process.env.PATH || ''}`,
            PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONDONTWRITEBYTECODE: '1',
            TORA_EVAL_TEST_COMMAND: `python3 -m pytest -q ${task.test}`,
          } : {}),
          TORA_HOME: join(taskDir, 'agent-state'),
          TORA_EVAL_RUN: runnerKind === 'tora-desktop' ? '1' : '',
          ...(runnerKind === 'dsh' ? {
            DSH_HOME: join(taskDir, 'dsh-home'),
            DSH_PERMISSION_MODE: 'danger-full-access',
            DSH_TELEMETRY_DISABLED: '1'
          } : {})
        },
        // A runner must not be able to ignore SIGTERM and overrun this deadline.
        encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024,
      });
      const elapsedMs = Date.now() - start;
      const summary = readRunSummary(taskDir, child.stdout || '');
      const { error: validationError, tests } = validateFixture(task, workspace);
      // Process failures veto correct artifacts and self-reported completion.
      let status;
      if (child.error?.code === 'ETIMEDOUT') status = 'timed-out';
      else if (child.error || child.status !== 0 || child.signal) status = 'runner-error';
      else if (summary.finishReason !== null && summary.finishReason !== 'completed') status = 'incomplete-run';
      else status = validationError ? 'failed-checks' : 'passed';
      let error = validationError;
      if (status === 'timed-out') error = child.error?.message || `Agent 超时（${timeoutMs}ms）；详见 agent.log`;
      else if (status === 'runner-error') error = child.error?.message || `Agent 退出码 ${child.status ?? '未知'}${child.signal ? `；信号 ${child.signal}` : ''}；详见 agent.log`;
      else if (status === 'incomplete-run') error = `Agent 运行未完成：${summary.finishReason}；详见 agent.log`;
      const passed = status === 'passed';
      const result = { id: task.id, status, passed, elapsedMs, exitCode: child.status, signal: child.signal || null,
        error, validationError, ...(publicSuite ? { baselineTests: initial.tests, tests } : {}), ...summary };
      results.push(result);
      writeFileSync(join(taskDir, 'agent.log'), redact(`${child.stdout || ''}\n${child.stderr || ''}`).slice(-200_000), { mode: 0o600 });
      console.log(`${passed ? '✓' : '✗'} ${task.id} [${status}] · ${(result.elapsedMs / 1000).toFixed(1)} 秒${result.error ? ` · ${result.error}` : ''}`);
    } finally {
      cpSync(workspace, join(taskDir, 'workspace'), { recursive: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  const completed = results.filter((task) => task.passed).length;
  const comparable = results.length === tasks.length && results.every((task) => task.status === 'passed' || task.status === 'failed-checks');
  const report = { schemaVersion: 1, agent: name, runnerKind, model, ...(publicSuite ? { dataset: publicSuite.dataset } : {}),
    workspaceIsolation: 'os-temp-outside-project', evaluatedAt: new Date().toISOString(), completed, total: tasks.length,
    score: comparable ? Math.round(completed / tasks.length * 100) : null, timeoutMs, results };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`通过 ${completed}/${tasks.length} 项，${comparable ? `完成率 ${report.score}%` : '存在超时、运行异常或未完成运行，暂不计算分数'} · 报告：${join(runDir, 'report.json')}`);
  if (completed !== tasks.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
