import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evaluator = fileURLToPath(new URL('../eval-work-execution.mjs', import.meta.url));
const metrics = { actionTurns: 2, modelCalls: 3, toolCalls: 4, failedToolCalls: 1, deniedToolCalls: 0, compactions: 0, usageReportedCalls: 2 };
const unknownMetrics = Object.fromEntries(Object.keys(metrics).map((key) => [key, null]));
const totalUsage = { prompt_tokens: 120, completion_tokens: 25, cached_tokens: 30 };
const solution = `export function parsePort(value) {
  if (!(typeof value === 'string' || Number.isInteger(value))) return null;
  const text = String(value);
  if (!/^[0-9]+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}`;
const repairPort = `writeFileSync('src/port.mjs', ${JSON.stringify(solution)});\n`;

function sessionFile(session, filename = 'fixture-session.json') {
  const content = typeof session === 'string' ? session : JSON.stringify(session);
  return `{
    const sessions = join(process.env.TORA_HOME, 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, ${JSON.stringify(filename)}), ${JSON.stringify(content)});
  }\n`;
}

function evaluate(t, code, { runnerKind = 'tora', task = 'strict-port', missingRunner = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'tora-eval-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const agent = join(temp, 'fixture-agent.mjs');
  writeFileSync(agent, `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\n${code}`);
  const runner = missingRunner ? [join(temp, 'missing-runner')] : [process.execPath, agent, '{prompt}'];
  const child = spawnSync(process.execPath, [
    evaluator, '--runner-kind', runnerKind, '--runner', JSON.stringify(runner), ...(task ? ['--task', task] : []),
    '--name', 'fixture', '--output-dir', temp, '--timeout-ms', '1000',
  ], {
    encoding: 'utf8', timeout: 15_000,
    // npm's shebang and fixture tests must use the same working Node as this test.
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` },
  });
  assert.ifError(child.error);
  const runDir = readdirSync(temp).find((entry) => entry.endsWith('-fixture'));
  assert.ok(runDir, child.stdout + child.stderr);
  const report = JSON.parse(readFileSync(join(temp, runDir, 'report.json'), 'utf8'));
  return { child, report, result: report.results[0], taskDir: task ? join(temp, runDir, task) : null };
}

function expectOutcome(run, status, score) {
  assert.equal(run.child.status, status === 'passed' ? 0 : 1, run.child.stdout + run.child.stderr);
  assert.equal(run.result.status, status);
  assert.equal(run.result.passed, status === 'passed');
  assert.equal(run.report.completed, status === 'passed' ? 1 : 0);
  assert.equal(run.report.total, 1);
  assert.equal(run.report.score, score);
}

test('只打印完成不能替代独立验收，也不从日志猜测摘要', t => {
  const run = evaluate(t, `console.log('全部完成，所有测试通过'); console.log('{"reason":"completed","metrics":{"modelCalls":1}}');`);
  expectOutcome(run, 'failed-checks', 0);
  assert.equal(run.result.finishReason, null);
  assert.equal(run.result.metrics, null);
  assert.equal(run.result.totalUsage, null);
  assert.ok(run.result.error);
});

test('没有结构化记录的通用 runner 交付正确产物仍可通过', t => {
  const run = evaluate(t, repairPort);
  expectOutcome(run, 'passed', 100);
  assert.equal(run.result.finishReason, null);
  assert.equal(run.result.metrics, null);
  assert.equal(run.result.totalUsage, null);
});

test('Codex 的用量和工具计数只来自结构化终止和工具事件', t => {
  const events = [
    { type: 'item.completed', item: { type: 'command_execution', status: 'failed' } },
    { type: 'item.completed', item: { type: 'agent_message' } },
    { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 9, cached_input_tokens: 10 } },
  ];
  const run = evaluate(t, repairPort + `console.log(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\n'))});`, {
    runnerKind: 'codex',
  });
  expectOutcome(run, 'passed', 100);
  assert.equal(run.result.finishReason, 'completed');
  assert.deepEqual(run.result.metrics, { toolCalls: 1, failedToolCalls: 1 });
  assert.deepEqual(run.result.totalUsage, { prompt_tokens: 50, completion_tokens: 9, cached_tokens: 10 });
});

test('Claude Code 计入缓存输入并去重流式重复工具块', t => {
  const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1' }] } };
  const final = { type: 'result', subtype: 'success', num_turns: 2, permission_denials: [],
    usage: { input_tokens: 50, output_tokens: 9, cache_creation_input_tokens: 4, cache_read_input_tokens: 10 } };
  const output = [tool, tool, final].map(event => JSON.stringify(event)).join('\n');
  const run = evaluate(t, repairPort + `console.log(${JSON.stringify(output)});`, { runnerKind: 'claude-code' });
  expectOutcome(run, 'passed', 100);
  assert.deepEqual(run.result.metrics, { actionTurns: 2, toolCalls: 1, deniedToolCalls: 0 });
  assert.deepEqual(run.result.totalUsage, { prompt_tokens: 64, completion_tokens: 9, cached_tokens: 10 });
});

test('正确产物通过验收，只收集结构化摘要白名单字段', t => {
  const secret = 'synthetic-secret-do-not-collect';
  const run = evaluate(t, repairPort + sessionFile({
    messages: [{ content: secret }], apiKey: secret,
    lastRun: { reason: 'completed', metrics: { ...metrics, extra: secret }, totalUsage: { ...totalUsage, extra: secret }, extra: secret },
  }));
  expectOutcome(run, 'passed', 100);
  assert.equal(run.result.finishReason, 'completed');
  assert.deepEqual(run.result.metrics, metrics);
  assert.deepEqual(run.result.totalUsage, totalUsage);
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.signal, null);
  assert.equal(run.result.error, null);
  assert.equal(run.result.validationError, null);
  assert.ok(!JSON.stringify(run.report).includes(secret), '报告不得收集消息、凭证或任意额外字段');
});

test('未知终止原因不能把任意文本或秘密采集到报告', t => {
  const secret = 'synthetic-secret-as-a-finish-reason';
  const run = evaluate(t, repairPort + sessionFile({ lastRun: { reason: secret, metrics, totalUsage } }));
  expectOutcome(run, 'passed', 100);
  assert.equal(run.result.finishReason, null);
  assert.equal(run.result.metrics, null);
  assert.ok(!JSON.stringify(run.report).includes(secret));
});

test('正确产物和 completed 摘要不能掩盖非零退出', t => {
  const run = evaluate(t, repairPort + sessionFile({ lastRun: { reason: 'completed', metrics, totalUsage } }) + 'process.exit(7);');
  expectOutcome(run, 'runner-error', null);
  assert.equal(run.result.exitCode, 7);
  assert.equal(run.result.finishReason, 'completed');
  assert.deepEqual(run.result.totalUsage, totalUsage);
  assert.equal(run.result.validationError, null);
  assert.ok(run.result.error);
});

test('正确产物后卡住仍判 timed-out，日志仍限长', t => {
  const run = evaluate(t, repairPort + sessionFile({ lastRun: { reason: 'completed', metrics } }) + `
    process.on('SIGTERM', () => {});
    process.stdout.write('x'.repeat(210_000));
    process.stderr.write('fixture-timeout');
    setInterval(() => {}, 60_000);
  `);
  expectOutcome(run, 'timed-out', null);
  assert.equal(run.result.signal, 'SIGKILL');
  assert.equal(run.result.finishReason, 'completed');
  assert.equal(run.result.validationError, null);
  assert.ok(run.result.error);
  const log = readFileSync(join(run.taskDir, 'agent.log'), 'utf8');
  assert.equal(log.length, 200_000);
  assert.ok(log.endsWith('fixture-timeout'));
});

test('信号退出是 runner-error 而不是 timed-out', t => {
  const run = evaluate(t, repairPort + sessionFile({ lastRun: { reason: 'completed' } }) + `process.kill(process.pid, 'SIGTERM');`);
  expectOutcome(run, 'runner-error', null);
  assert.equal(run.result.exitCode, null);
  assert.equal(run.result.signal, 'SIGTERM');
  assert.equal(run.result.validationError, null);
});

test('可执行程序不存在属于基础设施错误，不给模型计零分', t => {
  const run = evaluate(t, '', { missingRunner: true });
  expectOutcome(run, 'runner-error', null);
  assert.ok(run.result.error);
  assert.ok(run.result.validationError);
  assert.equal(run.result.finishReason, null);
});

test('exit 0 和正确产物不能掩盖 max-turns 未完成摘要', t => {
  const run = evaluate(t, repairPort + sessionFile({ lastRun: { reason: 'max-turns', metrics, totalUsage } }));
  expectOutcome(run, 'incomplete-run', null);
  assert.equal(run.result.exitCode, 0);
  assert.equal(run.result.finishReason, 'max-turns');
  assert.equal(run.result.validationError, null);
  assert.deepEqual(run.result.metrics, metrics);
  assert.deepEqual(run.result.totalUsage, totalUsage);
});

test('未完成运行同时保留独立验收失败，非零退出优先于未完成', t => {
  const incomplete = evaluate(t, sessionFile({ lastRun: { reason: 'max-turns' } }));
  expectOutcome(incomplete, 'incomplete-run', null);
  assert.ok(incomplete.result.validationError);
  const failed = evaluate(t, repairPort + sessionFile({ lastRun: { reason: 'max-turns' } }) + 'process.exit(2);');
  expectOutcome(failed, 'runner-error', null);
  assert.equal(failed.result.finishReason, 'max-turns');
});

for (const [label, lastRun, expectedUsage] of [
  ['usage 未上报不能把累计零值当真实用量', { reason: 'completed', metrics: { ...metrics, usageReportedCalls: 0 }, totalUsage }, null],
  ['缺少 usageReportedCalls 不能推断用量', { reason: 'completed', metrics: { actionTurns: 1 }, totalUsage }, null],
  ['有上报次数但缺少 totalUsage 时保持未知', { reason: 'completed', metrics }, null],
  ['部分 token 字段缺失保留 null', { reason: 'completed', metrics, totalUsage: { prompt_tokens: 12 } }, { prompt_tokens: 12, completion_tokens: null, cached_tokens: null }],
  ['真实上报的零用量不能误判缺失', { reason: 'completed', metrics, totalUsage: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 } }, { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }],
]) {
  test(label, t => {
    const run = evaluate(t, repairPort + sessionFile({ lastRun }));
    expectOutcome(run, 'passed', 100);
    assert.deepEqual(run.result.totalUsage, expectedUsage);
  });
}

test('非法指标不转换或猜测，已知零值保留', t => {
  const run = evaluate(t, repairPort + sessionFile({ lastRun: {
    reason: 'completed',
    metrics: { actionTurns: -1, modelCalls: 1.5, toolCalls: '4', failedToolCalls: false, deniedToolCalls: 0, compactions: null, usageReportedCalls: 1 },
    totalUsage: { prompt_tokens: '120', completion_tokens: -1, cached_tokens: 0 },
  } }));
  expectOutcome(run, 'passed', 100);
  assert.deepEqual(run.result.metrics, { ...unknownMetrics, deniedToolCalls: 0, usageReportedCalls: 1 });
  assert.deepEqual(run.result.totalUsage, { prompt_tokens: null, completion_tokens: null, cached_tokens: 0 });
});

for (const [label, code] of [
  ['缺少 session', ''],
  ['旧 session 缺少 lastRun', sessionFile({ messages: [] })],
  ['lastRun 缺少 reason', sessionFile({ lastRun: { metrics } })],
  ['摘要 JSON 损坏', sessionFile('{"lastRun":')],
  ['多个 session 不猜测取哪一个', sessionFile({ lastRun: { reason: 'completed' } }) + sessionFile({ lastRun: { reason: 'max-turns' } }, 'second.json')],
]) {
  test(`Tora ${label}时保留未知，不影响独立验收评分`, t => {
    const run = evaluate(t, repairPort + code + `console.log('completed');`);
    expectOutcome(run, 'passed', 100);
    assert.equal(run.result.finishReason, null);
    assert.equal(run.result.metrics, null);
    assert.equal(run.result.totalUsage, null);
    assert.equal(run.result.validationError, null);
    assert.equal(run.result.error, null);
  });
}

test('dsh 无 Tora 摘要仍可评分，状态目录和 Git 根保持隔离', t => {
  const run = evaluate(t, repairPort + `
    import { execFileSync } from 'node:child_process';
    let gitRoot = null;
    try { gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    writeFileSync('runner-env.json', JSON.stringify({
      home: process.env.DSH_HOME, toraHome: process.env.TORA_HOME,
      mode: process.env.DSH_PERMISSION_MODE, telemetry: process.env.DSH_TELEMETRY_DISABLED,
      gitRoot, cwd: process.cwd(),
    }));
  `, { runnerKind: 'dsh' });
  expectOutcome(run, 'passed', 100);
  assert.equal(run.report.runnerKind, 'dsh');
  assert.equal(run.result.finishReason, null);
  assert.equal(run.result.metrics, null);
  assert.equal(run.result.totalUsage, null);
  const env = JSON.parse(readFileSync(join(run.taskDir, 'workspace', 'runner-env.json'), 'utf8'));
  assert.equal(env.home, join(run.taskDir, 'dsh-home'));
  assert.equal(env.toraHome, join(run.taskDir, 'agent-state'));
  assert.equal(env.mode, 'danger-full-access');
  assert.equal(env.telemetry, '1');
  assert.equal(env.gitRoot, null, '评测工作区不得继承父项目 Git 仓库');
  assert.ok(env.cwd.includes('tora-eval-strict-port-'));
});

test('dsh 不读取其他协议的 Tora session 摘要', t => {
  const run = evaluate(t, repairPort + sessionFile({ lastRun: { reason: 'max-turns', metrics, totalUsage } }), { runnerKind: 'dsh' });
  expectOutcome(run, 'passed', 100);
  assert.equal(run.result.finishReason, null);
  assert.equal(run.result.metrics, null);
  assert.equal(run.result.totalUsage, null);
});

for (const [reason, status, score] of [
  ['completed', 'failed-checks', 33],
  ['max-turns', 'incomplete-run', null],
]) {
  test(`三题混合结果在 ${reason} 时使用保守总分`, t => {
    const run = evaluate(t, `
      if (existsSync('src/port.mjs')) { ${repairPort} }
      if (existsSync('src/inventory.mjs')) { ${sessionFile({ lastRun: { reason } })} }
      else { ${sessionFile({ lastRun: { reason: 'completed' } })} }
    `, { task: null });
    assert.equal(run.child.status, 1, run.child.stdout + run.child.stderr);
    assert.equal(run.report.total, 3);
    assert.equal(run.report.completed, 1);
    assert.deepEqual(run.report.results.map((result) => result.status), ['passed', status, 'failed-checks']);
    assert.equal(run.report.score, score);
  });
}

test('red-to-green 的 npm 验收使用临时 PATH 中的有效 Node', t => {
  const displayName = `export function formatDisplayName(value) { return value == null || !String(value).trim() ? '访客' : String(value).trim().replace(/\\s+/g, ' '); }`;
  const run = evaluate(t, `writeFileSync('src/display-name.mjs', ${JSON.stringify(displayName)});\n` + sessionFile({ lastRun: { reason: 'completed' } }), { task: 'red-to-green' });
  expectOutcome(run, 'passed', 100);
});
