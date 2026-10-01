import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'tora-harness-test-'));
process.env.TORA_HOME = testHome;
after(() => rmSync(testHome, { recursive: true, force: true }));

const { createToolRegistry, runToolPipeline } = await import('../src/tools/registry.js');
const { createSessionRecord, loadSessionRecord, saveSessionRecord, forkSession, deleteSession } = await import('../src/asapi/store.js');
const { appendSessionEvent, readSessionEvents, sessionEventPath } = await import('../src/asapi/session-events.js');
const { userMsg, assistantMsgShell } = await import('../src/asapi/protocol.js');

test('工具流水线拒绝优先，允许后按改写参数执行并处理结果', async () => {
  let executions = 0;
  let postChecks = 0;
  const registry = createToolRegistry([{
    name: 'Probe', description: 'probe', parameters: {},
    async execute(args) { executions++; return { text: args.value, meta: { changed: true } }; }
  }], (name) => name);
  const call = { function: { name: 'Probe' } };
  const denied = () => ({ ok: false, result: 'denied', durationMs: 0 });
  const blocked = await runToolPipeline({
    call, args: { value: 'old' }, before: async () => ({ behavior: 'deny' }),
    invoke: (tc, args) => registry.invoke(tc, args, { cwd: testHome }),
    after: async () => { postChecks++; }, denied
  });
  assert.equal(blocked.result, 'denied');
  assert.equal(executions, 0);
  assert.equal(postChecks, 0);

  const allowed = await runToolPipeline({
    call, args: { value: 'old' }, before: async () => ({ behavior: 'allow', args: { value: 'updated' } }),
    invoke: (tc, args) => registry.invoke(tc, args, { cwd: testHome }),
    after: async (_tc, _args, result) => { postChecks++; return { ...result, result: `${result.result}!` }; },
    denied
  });
  assert.equal(allowed.result, 'updated!');
  assert.deepEqual(allowed.meta, { changed: true });
  assert.equal(executions, 1);
  assert.equal(postChecks, 1);
});

test('工具异常与非零 Bash 退出统一为失败', async () => {
  const registry = createToolRegistry([
    { name: 'Bash', description: '', parameters: {}, execute: async () => 'exit_code: 7' },
    { name: 'Broken', description: '', parameters: {}, execute: async () => { throw new Error('broken'); } }
  ], (name) => name);
  const context = { cwd: testHome };
  assert.equal((await registry.invoke({ function: { name: 'Bash' } }, {}, context)).ok, false);
  assert.match((await registry.invoke({ function: { name: 'Broken' } }, {}, context)).result, /broken/);
  assert.equal((await registry.invoke({ function: { name: 'Missing' } }, {}, context)).ok, false);
  assert.throws(() => createToolRegistry([
    { name: 'Bash', execute: async () => 'ok' },
    { name: 'Bash', execute: async () => 'override' }
  ], (name) => name), /工具名重复/);
});

test('追加式会话日志恢复未保存的消息、工具结果和完成状态，并保留后续编辑与分支', () => {
  const record = createSessionRecord({ agent_id: 'agent', toraCfg: { model: 'mock' } });
  const user = userMsg('修复问题');
  const internal = [{ role: 'user', content: '修复问题' }];
  appendSessionEvent(record.id, 'run-started', { replyId: 'reply-1', user, internal });
  let recovered = loadSessionRecord(record.id);
  assert.equal(recovered.display[0].content[0].text, '修复问题');
  assert.deepEqual(recovered.internal, internal);
  saveSessionRecord(recovered);

  const progress = assistantMsgShell('reply-1');
  progress.content = [
    { id: 'call-1', type: 'tool_call', name: 'Read', input: '{}', state: 'finished' },
    { id: 'call-1', type: 'tool_result', name: 'Read', output: [{ type: 'text', text: '文件内容' }], state: 'success' }
  ];
  const withTool = [...internal, { role: 'assistant', tool_calls: [{ id: 'call-1' }] }, { role: 'tool', tool_call_id: 'call-1', content: '文件内容' }];
  appendSessionEvent(record.id, 'reply-progress', { reply: progress, internal: withTool });
  recovered = loadSessionRecord(record.id);
  assert.equal(recovered.display[1].content[1].output[0].text, '文件内容');
  assert.equal(recovered.internal.at(-1).content, '文件内容');

  // A later explicit edit must survive replay of older journal entries.
  recovered.config.name = '手工命名';
  recovered.display[0].content[0].text = '修复问题（已编辑）';
  saveSessionRecord(recovered);
  assert.equal(loadSessionRecord(record.id).display[0].content[0].text, '修复问题（已编辑）');

  const finished = { ...progress, finished_reason: 'completed', finished_at: new Date().toISOString() };
  appendSessionEvent(record.id, 'reply-finished', { reply: finished, internal: withTool });
  recovered = loadSessionRecord(record.id);
  assert.equal(recovered.display[1].finished_reason, 'completed');
  const branch = forkSession(record.id, { name: '恢复后的分支' });
  assert.equal(loadSessionRecord(branch.id).display[1].finished_reason, 'completed');
  deleteSession(branch.id);

  // Ignore a partial last record, then truncate it before the next append.
  appendFileSync(sessionEventPath(record.id), '{"partial":');
  assert.equal(readSessionEvents(record.id).events.at(-1).type, 'reply-finished');
  appendSessionEvent(record.id, 'internal-snapshot', { internal: withTool });
  assert.equal(readSessionEvents(record.id).events.at(-1).type, 'internal-snapshot');
  assert.ok(readFileSync(sessionEventPath(record.id), 'utf8').endsWith('\n'));
  saveSessionRecord(loadSessionRecord(record.id));
  appendFileSync(sessionEventPath(record.id), 'not-json\n');
  const fallback = loadSessionRecord(record.id);
  assert.equal(fallback.display[1].finished_reason, 'completed', '损坏日志时保留最后的 JSON 快照');
  saveSessionRecord(fallback);
  assert.equal(existsSync(sessionEventPath(record.id)), false);
  assert.ok(readdirSync(join(testHome, 'asapi', 'sessions')).some((name) => name.startsWith(`${record.id}.events.jsonl.corrupt-`)));
  deleteSession(record.id);
  assert.equal(existsSync(sessionEventPath(record.id)), false);
});
