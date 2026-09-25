import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'cocode-insights-test-'));
process.env.COCODE_HOME = join(root, 'data');
const { beginDelivery, finishDelivery, listDeliveries } = await import('../src/delivery.js');
const { analyzeImpact } = await import('../src/impact.js');
const { createTrace } = await import('../src/trace.js');
const { startASAPIServer } = await import('../src/asapi/server.js');

test('交付报告只记录运行窗口内差异，并保留无法归因说明', () => {
  const cwd = join(root, 'delivery');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'existing.ts'), 'before');
  mkdirSync(join(cwd, '.github'));
  writeFileSync(join(cwd, '.github', 'ci.yml'), 'before');
  const context = beginDelivery({ sessionId: 'delivery-test', cwd });
  writeFileSync(join(cwd, 'existing.ts'), 'after');
  writeFileSync(join(cwd, '.github', 'ci.yml'), 'after');
  writeFileSync(join(cwd, 'new.ts'), 'new');
  const report = finishDelivery(context);
  assert.deepEqual(report.changedFiles, [
    { path: '.github/ci.yml', change: 'modified' },
    { path: 'existing.ts', change: 'modified' },
    { path: 'new.ts', change: 'added' },
  ]);
  assert.equal(report.checks.length, 0);
  assert.match(report.warnings.join(' '), /无法区分同时进行的人工/);
  assert.equal(listDeliveries('delivery-test')[0].id, report.id);
  assert.ok(readFileSync(join(process.env.COCODE_HOME, 'deliveries', 'delivery-test', `${report.id}.json`), 'utf8'));
});

test('影响雷达沿相对导入反向追踪并把测试标为建议', async () => {
  const cwd = join(root, 'impact');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'base.ts'), 'export const value = 1;');
  writeFileSync(join(cwd, 'consumer.ts'), "import { value } from './base';\nexport { value };");
  writeFileSync(join(cwd, 'consumer.test.ts'), "import { value } from './consumer';\nvoid value;");
  const result = await analyzeImpact(cwd, { paths: ['base.ts'] });
  assert.deepEqual(result.affected.map((item) => item.path), ['consumer.ts', 'consumer.test.ts']);
  assert.deepEqual(result.suggestedTests, ['consumer.test.ts']);
  assert.equal(result.source, 'manual');
  assert.ok(result.warnings.some((item) => item.includes('不会') || item.includes('遗漏')));
});

test('验证状态以命令退出码为准，失败不标记通过', () => {
  const cwd = join(root, 'checks');
  mkdirSync(cwd);
  const trace = createTrace({ sessionId: 'checks-test', cwd, cfg: { traceEnabled: true } });
  const context = beginDelivery({ sessionId: 'checks-test', cwd, traceId: trace.id });
  trace.tool({ id: 'one', name: 'Bash', args: { command: 'npm test' }, ok: true, result: 'exit_code: 1\nfailed' });
  trace.tool({ id: 'two', name: 'Bash', args: { command: 'npm run build' }, ok: true, result: 'exit_code: 0\nok' });
  trace.event({ type: 'review-result', round: 1, passed: false, issues: ['缺少边界测试'], reason: 'needs-work' });
  trace.end('complete');
  const report = finishDelivery(context);
  assert.deepEqual(report.checks.map((item) => item.status), ['failed', 'passed']);
  assert.equal(report.traceId, trace.id);
  assert.equal(report.outcome, 'complete');
  assert.equal(report.modelReview.status, 'failed');
});

test('Git 模式读取未提交目标，拒绝越界手动路径', async () => {
  const cwd = join(root, 'git-impact');
  mkdirSync(cwd);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
  writeFileSync(join(cwd, 'entry.ts'), 'export {}');
  const result = await analyzeImpact(cwd);
  assert.deepEqual(result.targets, ['entry.ts']);
  const bounded = await analyzeImpact(cwd, { paths: ['../outside.ts', 'entry.ts'] });
  assert.deepEqual(bounded.targets, ['entry.ts']);
});

test('会话 API 提供交付历史与项目影响分析', async () => {
  const cwd = join(root, 'api-impact');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'entry.ts'), 'export const entry = true;');
  const server = await startASAPIServer({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const agents = await (await fetch(`${base}/agent/`)).json();
    const created = await (await fetch(`${base}/sessions/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agents.agents[0].id, cwd, delivery_mode: true, delivery_criteria: '测试必须通过' }),
    })).json();
    assert.ok(created.session_id);
    const session = await (await fetch(`${base}/sessions/${created.session_id}`)).json();
    assert.equal(session.session.state.delivery_mode, true);
    assert.equal(session.session.state.delivery_criteria, '测试必须通过');
    const context = beginDelivery({ sessionId: created.session_id, cwd, modeEnabled: true, criteria: '测试必须通过' });
    finishDelivery(context);
    const history = await (await fetch(`${base}/sessions/${created.session_id}/deliveries`)).json();
    assert.equal(history.reports.length, 1);
    assert.equal(history.reports[0].modeEnabled, true);
    assert.deepEqual(history.reports[0].criteria, ['测试必须通过']);
    const updated = await (await fetch(`${base}/sessions/${created.session_id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delivery_mode: false }),
    })).json();
    assert.equal(updated.state.delivery_mode, false);
    const impact = await (await fetch(`${base}/workspace/impact?session_id=${created.session_id}&paths=entry.ts`)).json();
    assert.deepEqual(impact.targets, ['entry.ts']);
  } finally {
    server.close();
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
