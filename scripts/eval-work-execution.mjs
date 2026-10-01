#!/usr/bin/env node
// 在全新临时工作区运行同一批小型工程任务；评分只看独立验收，不听 Agent 自报完成。
import { parseArgs } from 'node:util';
import { cpSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validate } from './eval-suite/validators.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allTasks = JSON.parse(readFileSync(new URL('./eval-suite/tasks.json', import.meta.url), 'utf8'));
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
    help: { type: 'boolean' },
  },
});

if (values.help || (!values['check-fixtures'] && !values.runner)) {
  console.log('用法：node scripts/eval-work-execution.mjs --check-fixtures');
  console.log('      node scripts/eval-work-execution.mjs --name Tora --runner \'["node","/绝对路径/Tora/packages/cli/src/index.js","{prompt}"]\'');
  console.log('runner 是 JSON 数组；{prompt} 会替换成任务描述，未写占位符时追加在参数末尾。');
  console.log('--runner-kind tora|dsh：dsh 使用独立 DSH_HOME 和非交互执行权限。');
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
if (!['tora', 'dsh'].includes(runnerKind)) throw new Error('runner-kind 只能是 tora 或 dsh');
const tasks = values.task ? allTasks.filter((task) => task.id === values.task) : allTasks;
if (!tasks.length) throw new Error(`未知任务：${values.task}`);
let modelEnv = {};
let model = null;
if (values['model-from-config']) {
  const { loadConfig } = await import('../packages/core/src/config.js');
  const cfg = loadConfig();
  if (String(cfg.baseURL || '').includes('/official/v1')) {
    console.error('评测配置错误：当前配置指向仅供桌面会话使用的官方模型网关；CLI 评测需先配置自接入的 OpenAI 兼容模型');
    process.exit(2);
  }
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseURL || '')) throw new Error('现有配置没有可用模型凭证');
  model = cfg.model;
  if (runnerKind === 'dsh') {
    const url = new URL(cfg.baseURL);
    if (url.hostname !== 'api.deepseek.com' || cfg.model !== 'deepseek-flash' || !cfg.apiKey) {
      throw new Error('dsh 同题评测要求现有配置使用 DeepSeek 官方 deepseek-flash 和有效凭证');
    }
    // dsh's official adapter uses the Messages endpoint; Tora's own CLI uses
    // the OpenAI-compatible endpoint. Both route to the same model id/key.
    modelEnv = { DEEPSEEK_API_KEY: cfg.apiKey };
  } else {
    modelEnv = { TORA_BASE_URL: cfg.baseURL, TORA_API_KEY: cfg.apiKey, TORA_MODEL: cfg.model };
  }
}

function seed(task, workspace) {
  for (const [relative, content] of Object.entries(task.files)) {
    if (!/^(?:src|test|package\.json)(?:\/[-\w.]+)*$/.test(relative) || relative.includes('..')) throw new Error(`非法 fixture 路径：${relative}`);
    const dest = join(workspace, relative);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}

async function initialFailure(task, workspace) {
  try { await validate(task.id, workspace); }
  catch { return; }
  throw new Error(`${task.id} 初始状态已通过验收，无法作为评测题`);
}

async function main() {
  if (values['check-fixtures']) {
    for (const task of tasks) {
      const workspace = mkdtempSync(join(tmpdir(), 'tora-eval-fixture-'));
      try { seed(task, workspace); await initialFailure(task, workspace); console.log(`✓ ${task.id}：初始状态未通过验收`); }
      finally { rmSync(workspace, { recursive: true, force: true }); }
    }
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputBase = values['output-dir'] ? resolve(values['output-dir']) : resolve(project, 'output', 'agent-eval');
  const runDir = join(outputBase, `${stamp}-${name}`);
  mkdirSync(runDir, { recursive: true });
  const results = [];
  for (const task of tasks) {
    const taskDir = join(runDir, task.id);
    mkdirSync(taskDir, { recursive: true });
    // The report stays in the project, but the live workspace must not inherit
    // this project's Git root, AGENTS.md, hooks, or repo map.
    const workspace = mkdtempSync(join(tmpdir(), `tora-eval-${task.id}-`));
    try {
      seed(task, workspace);
      await initialFailure(task, workspace);
      const args = runner.slice(1).map((arg) => arg.replaceAll('{prompt}', task.prompt));
      if (!runner.slice(1).some((arg) => arg.includes('{prompt}'))) args.push(task.prompt);
      const start = Date.now();
      const child = spawnSync(runner[0], args, {
        cwd: workspace,
        env: {
          ...process.env, ...modelEnv,
          TORA_HOME: join(taskDir, 'agent-state'),
          ...(runnerKind === 'dsh' ? {
            DSH_HOME: join(taskDir, 'dsh-home'),
            DSH_PERMISSION_MODE: 'danger-full-access',
            DSH_TELEMETRY_DISABLED: '1'
          } : {})
        },
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024,
      });
      let error = null;
      try { await validate(task.id, workspace); }
      catch (e) { error = String(e?.message || e).slice(0, 800); }
      const status = child.error || child.status !== 0 ? 'runner-error' : error ? 'failed-checks' : 'passed';
      const passed = status === 'passed';
      const result = { id: task.id, status, passed, elapsedMs: Date.now() - start, exitCode: child.status, signal: child.signal || null, error: child.error?.message || (status === 'runner-error' ? `Agent 退出码 ${child.status ?? '未知'}；详见 agent.log` : error) || null };
      results.push(result);
      writeFileSync(join(taskDir, 'agent.log'), `${child.stdout || ''}\n${child.stderr || ''}`.slice(-200_000));
      console.log(`${passed ? '✓' : '✗'} ${task.id} [${status}] · ${(result.elapsedMs / 1000).toFixed(1)} 秒${result.error ? ` · ${result.error}` : ''}`);
    } finally {
      cpSync(workspace, join(taskDir, 'workspace'), { recursive: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  const completed = results.filter((task) => task.passed).length;
  const comparable = results.every((task) => task.status !== 'runner-error');
  const report = { schemaVersion: 1, agent: name, runnerKind, model, workspaceIsolation: 'os-temp-outside-project', evaluatedAt: new Date().toISOString(), completed, total: tasks.length, score: comparable ? Math.round(completed / tasks.length * 100) : null, timeoutMs, results };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`通过 ${completed}/${tasks.length} 项，${comparable ? `完成率 ${report.score}%` : '存在运行环境错误，暂不计算分数'} · 报告：${join(runDir, 'report.json')}`);
  if (completed !== tasks.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
