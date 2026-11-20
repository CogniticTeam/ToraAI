import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'tora-harness-test-'));
process.env.TORA_HOME = testHome;
after(() => rmSync(testHome, { recursive: true, force: true }));

const { createToolRegistry, runToolPipeline } = await import('../src/tools/registry.js');
const { taskTools } = await import('../src/tools/tasks.js');
const { createSessionRecord, loadSessionRecord, saveSessionRecord, forkSession, deleteSession } = await import('../src/asapi/store.js');
const { appendSessionEvent, readSessionEvents, sessionEventPath } = await import('../src/asapi/session-events.js');
const { userMsg, assistantMsgShell } = await import('../src/asapi/protocol.js');
const { compactMessages, estimateMessagesTokens } = await import('../src/context.js');
const { runAgent } = await import('../src/agent.js');
const { setModelFetcher } = await import('../src/model-transport.js');
const { runOneShot } = await import('../../cli/src/repl.js');

const completion = message => Response.json({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 8, completion_tokens: 3 } });
const action = (name, args, id = 'call') => ({ content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] });
async function runFixture(t, respond, opts = {}) {
  const requests = [];
  setModelFetcher(async (url, init) => {
    assert.ok(url.startsWith('https://harness.invalid/'));
    const request = JSON.parse(init.body);
    requests.push(request);
    const result = await respond(request, requests.length);
    return result instanceof Response ? result : completion(result);
  });
  t.after(() => setModelFetcher(null));
  const cfg = { baseURL: 'https://harness.invalid/v1', apiKey: 'fixture', model: t.name, thinking: false,
    hooksEnabled: false, injectProjectContext: false, repoMapInject: false, checkpointEnabled: false, mcpServers: {},
    maxTurns: 40, maxTokensBudget: 24000, ...opts.cfg };
  const messages = opts.messages ?? [{ role: 'user', content: '完成测试任务' }];
  const events = [];
  for await (const event of runAgent({ cwd: testHome, permissionMode: 'bypass', ...opts, cfg, messages })) events.push(event);
  return { requests, messages, events, done: events.findLast(event => event.type === 'done') };
}
const review = { enabled: true, min_turns: 0, max_rounds: 1, checklist: ['结果正确'] };
const countSchema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };

test('返工必须遵守本次运行的动作轮数，而不是配置额度加五轮', async t => {
  let actions = 0;
  const result = await runFixture(t, body => {
    if (body.tools) { actions++; return { content: '已完成' }; }
    return { content: JSON.stringify({ passed: false, issues: ['仍需修复'], reason: '未通过' }) };
  }, { maxTurns: 1, cfg: { review } });
  assert.equal(actions, 1);
  assert.equal(result.done.reason, 'max-turns');
});

test('复核阈值仅计算本次运行的工具请求，不使用历史调用', async t => {
  const messages = [{ role: 'system', content: 'rules' }];
  for (let i = 0; i < 3; i++) messages.push({ role: 'assistant', tool_calls: [readCall(`old-${i}`)] }, toolReply(`old-${i}`));
  messages.push({ role: 'user', content: '只回答这个问题' });
  const result = await runFixture(t, () => ({ content: '回答' }), { messages, cfg: { review: { ...review, min_turns: 3 } } });
  assert.equal(result.requests.length, 1);
  assert.equal(result.done.reason, 'completed');
});

test('复核请求包含本次用户目标，而不只看工具和最终回答', async t => {
  let criticInput;
  const result = await runFixture(t, body => {
    if (body.tools) return { content: '完成' };
    criticInput = JSON.stringify(body.messages);
    return { content: '{"passed":true,"issues":[],"reason":"通过"}' };
  }, { messages: [{ role: 'user', content: 'CURRENT_TASK_TARGET' }], cfg: { review } });
  assert.equal(result.done.reason, 'completed');
  assert.ok(criticInput.includes('CURRENT_TASK_TARGET'));
});

test('结构化重试会收到上次候选及具体校验错误', async t => {
  let attempts = 0;
  const result = await runFixture(t, body => {
    if (body.tools) return { content: '原始产出' };
    attempts++;
    return { content: attempts === 1 ? '{"count":"bad"}' : '{"count":2}' };
  }, { cfg: { output_schema: countSchema, output_schema_max_rounds: 1 } });
  assert.equal(result.done.reason, 'completed');
  assert.ok(JSON.stringify(result.requests[2].messages).includes('/count'));
  assert.ok(JSON.stringify(result.requests[2].messages).includes('实际是 string'));
  assert.ok(JSON.stringify(result.requests[2].messages).includes('bad'));
});

test('结构化输出耗尽与复核失败都不能冒充 completed', async t => {
  const result = await runFixture(t, body => body.tools ? { content: '产出' } : { content: 'not-json' }, {
    cfg: { output_schema: countSchema, output_schema_max_rounds: 0 },
  });
  assert.equal(result.done.reason, 'error');
  assert.ok(result.done.error);
});

test('复核失败后达到轮次上限以错误收尾', async t => {
  const result = await runFixture(t, body => body.tools ? { content: '产出' }
    : { content: '{"passed":false,"issues":["未通过"],"reason":"失败"}' }, {
    cfg: { review: { ...review, max_rounds: 0 } },
  });
  assert.equal(result.done.reason, 'error');
});

test('辅助模型调用中止后不能返回成功或继续请求', async t => {
  for (const mode of ['review', 'structured']) {
    const controller = new AbortController();
    let requests = 0;
    const result = await runFixture(t, body => {
      requests++;
      if (body.tools) return { content: '原始产出' };
      controller.abort();
      throw Object.assign(new Error('stop'), { code: 'ABORTED' });
    }, { signal: controller.signal, cfg: mode === 'review' ? { review } : { output_schema: countSchema } });
    assert.equal(result.done.reason, 'aborted');
    assert.equal(requests, 2);
  }
});

test('预先取消的运行不启动模型，即使尚未配置密钥', async t => {
  const controller = new AbortController(); controller.abort();
  const result = await runFixture(t, () => { throw new Error('不应发出请求'); }, {
    signal: controller.signal, cfg: { apiKey: '' },
  });
  assert.equal(result.done.reason, 'aborted');
  assert.equal(result.requests.length, 0);
});

test('工具参数解析错误或违反声明类型时不得用空参继续执行', async t => {
  for (const args of ['{', '{"value":"bad"}']) {
    let executions = 0;
    const tool = { name: 'Probe', description: 'fixture', parameters: {
      type: 'object', properties: { value: { type: 'integer' } }, required: ['value'],
    }, execute: async () => { executions++; return 'ok'; } };
    const result = await runFixture(t, (_body, i) => i === 1 ? action('Probe', args) : { content: '已处理失败' }, { extraTools: [tool] });
    assert.equal(executions, 0);
    const response = result.events.find(event => event.type === 'tool-result');
    assert.equal(response.ok, false);
    assert.equal(response.meta.failure.kind, 'invalid-arguments');
  }
});

test('明确不可重试的重复失败会终止空转，但不增加请求', async t => {
  const result = await runFixture(t, () => action('MissingTool', {}, 'missing'), { maxTurns: 20 });
  assert.equal(result.done.reason, 'error');
  assert.equal(result.requests.length, 3);
  assert.match(result.done.error, /重复|进展/);
});

test('不同的参数修复尝试不能被空对象指纹误判为空转', async t => {
  let executions = 0;
  const tool = { name: 'Probe', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => { executions++; return 'ok'; } };
  const result = await runFixture(t, (_body, i) => i <= 4 ? action('Probe', `{"value":${i},`)
    : i === 5 ? action('Probe', { value: 5 }) : { content: '完成' }, { extraTools: [tool], maxTurns: 8 });
  assert.equal(result.done.reason, 'completed');
  assert.equal(result.requests.length, 6);
  assert.equal(executions, 1);
});

test('成功重复调用和未分类外部失败不被当作死循环', async t => {
  for (const failed of [false, true]) {
    let executions = 0;
    const tool = { name: 'Probe', description: 'fixture', parameters: { type: 'object', properties: {} },
      execute: async () => { executions++; return failed ? { ok: false, text: '暂时不可用' } : '状态未变化'; } };
    const result = await runFixture(t, (_body, i) => i <= 4 ? action('Probe', {}, `poll-${i}`) : { content: '完成' }, { extraTools: [tool] });
    assert.equal(result.done.reason, 'completed');
    assert.equal(executions, 4);
    assert.equal(result.requests.length, 5);
  }
});

test('正常运行返回结构化计数与实际用量，且不增加模型调用', async t => {
  const result = await runFixture(t, () => ({ content: '完成' }));
  assert.equal(result.requests.length, 1);
  assert.equal(result.done.metrics.actionTurns, 1);
  assert.equal(result.done.metrics.modelCalls, 1);
  assert.equal(result.done.metrics.toolCalls, 0);
  assert.equal(result.done.metrics.usageReportedCalls, 1);
  assert.equal(result.done.totalUsage.prompt_tokens, 8);
});

const readCall = id => ({ id, type: 'function', function: { name: 'Read', arguments: '{}' } });
const toolReply = id => ({ role: 'tool', tool_call_id: id, content: `result ${id}` });
function assertCompleteToolGroups(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === 'tool') {
      assert.ok(pending.delete(message.tool_call_id), `孤立或重复的工具结果 ${message.tool_call_id}`);
    } else {
      assert.equal(pending.size, 0, '工具结果未配齐就出现下一条消息');
      for (const call of message.tool_calls || []) {
        assert.ok(!pending.has(call.id), `重复工具调用 ${call.id}`);
        pending.add(call.id);
      }
    }
  }
  assert.equal(pending.size, 0, '工具调用缺少结果');
}

test('CLI 一次性运行保存结构化摘要并正确返回非成功退出码', async t => {
  let activeController;
  const NativeAbortController = globalThis.AbortController;
  const controllerMock = t.mock.method(globalThis, 'AbortController', function () {
    activeController = new NativeAbortController();
    return activeController;
  });
  t.after(() => controllerMock.mock.restore());
  const cases = [
    ['completed', () => ({ content: '完成' }), {}, 0],
    ['max-turns', () => action('MissingTool', {}), { maxTurns: 1 }, 1],
    ['aborted', () => { activeController.abort(); throw Object.assign(new Error('stop'), { code: 'ABORTED' }); }, {}, 130],
  ];
  for (const [reason, respond, patch, expectedExit] of cases) {
    const sessions = join(testHome, 'sessions');
    const previousFiles = new Set(existsSync(sessions) ? readdirSync(sessions) : []);
    const previousExit = process.exitCode;
    const listeners = process.listenerCount('SIGINT');
    const output = t.mock.method(process.stdout, 'write', () => true);
    const cwd = t.mock.method(process, 'cwd', () => testHome);
    setModelFetcher(async () => completion(await respond()));
    try {
      process.exitCode = 0;
      await runOneShot({ baseURL: 'https://harness.invalid/v1', apiKey: 'fixture', model: 'cli-fixture', thinking: false,
        hooksEnabled: false, injectProjectContext: false, repoMapInject: false, checkpointEnabled: false,
        permissionMode: 'bypass', mcpServers: {}, ...patch }, 'fixture CLI task');
      assert.equal(process.exitCode, expectedExit, reason);
      const created = readdirSync(sessions).filter(name => !previousFiles.has(name));
      assert.equal(created.length, 1);
      const record = JSON.parse(readFileSync(join(sessions, created[0]), 'utf8'));
      assert.equal(record.lastRun.reason, reason);
      assert.equal(typeof record.lastRun.metrics.modelCalls, 'number');
      assert.equal(record.lastRun.totalUsage?.prompt_tokens ?? null, reason === 'aborted' ? null : 8);
      assert.equal(process.listenerCount('SIGINT'), listeners);
    } finally {
      process.exitCode = previousExit;
      setModelFetcher(null); output.mock.restore(); cwd.mock.restore();
    }
  }
});

test('Subagent 继承父显式 deny 和 ask，不因 bypass 丢失约束', async t => {
  writeFileSync(join(testHome, 'child-protected.txt'), 'PRIVATE_FIXTURE_CONTENT');
  for (const behavior of ['deny', 'ask']) {
    let parentRound = 0, childRound = 0, childResult;
    const result = await runFixture(t, body => {
      if (body.messages.some(m => m.content === 'CHILD_RULES')) {
        childRound++;
        if (childRound === 1) return action('Read', { path: 'child-protected.txt' }, 'child-read');
        childResult = body.messages.find(m => m.role === 'tool')?.content;
        return { content: '子任务结束' };
      }
      return ++parentRound === 1 ? action('Subagent', { prompt: 'CHILD_RULES' }, 'delegate') : { content: '结束' };
    }, { permissionRules: [{ tool_name: 'Read', rule_content: 'child-protected.txt', behavior }] });
    assert.equal(result.done.reason, 'completed');
    assert.equal(typeof childResult, 'string');
    assert.ok(!childResult.includes('PRIVATE_FIXTURE_CONTENT'), `${behavior} 规则必须在子代理仍生效`);
    assert.match(childResult, /拒绝|询问无法送达/);
  }
});

test('Subagent 运行中同步父模式收紧，不保留旧 bypass 快照', async t => {
  let mode = 'bypass', parentRound = 0, childRound = 0;
  const result = await runFixture(t, body => {
    if (body.messages.some(m => m.content === 'CHILD_SCOPE')) {
      if (++childRound === 1) {
        mode = 'explore';
        return action('Write', { path: 'child-forbidden.txt', content: 'no' }, 'child-write');
      }
      return { content: '已停止写入' };
    }
    return ++parentRound === 1 ? action('Subagent', { prompt: 'CHILD_SCOPE' }, 'delegate') : { content: '结束' };
  }, { readPermissionMode: () => mode });
  assert.equal(result.done.reason, 'completed');
  assert.equal(existsSync(join(testHome, 'child-forbidden.txt')), false);
});

test('子代理动态继承父级新加入的 deny', async t => {
  writeFileSync(join(testHome, 'child-live-rule.txt'), 'PRIVATE_LIVE_FIXTURE');
  let parentRound = 0, childRound = 0, childResult;
  const inherited = [];
  const result = await runFixture(t, body => {
    if (body.messages.some(m => m.content === 'CHILD_LIVE_RULE')) {
      if (++childRound === 1) {
        inherited.push({ tool_name: 'Read', rule_content: 'child-live-rule.txt', behavior: 'deny' });
        return action('Read', { path: 'child-live-rule.txt' }, 'child-read');
      }
      childResult = body.messages.find(m => m.role === 'tool')?.content;
      return { content: '子任务结束' };
    }
    return ++parentRound === 1 ? action('Subagent', { prompt: 'CHILD_LIVE_RULE' }, 'delegate') : { content: '结束' };
  }, { readPermissionRules: () => inherited });
  assert.equal(result.done.reason, 'completed');
  assert.match(childResult, /拒绝/);
  assert.ok(!childResult.includes('PRIVATE_LIVE_FIXTURE'));
});

test('Team 通过公共工具入口派生 worker 时仍继承父 deny', async t => {
  const captain = createSessionRecord({ agent_id: 'fixture-captain', cwd: testHome,
    toraCfg: { model: 'fixture', baseURL: 'https://harness.invalid/v1', apiKey: 'fixture' } });
  captain.state.permission_mode = 'bypass';
  saveSessionRecord(captain);
  writeFileSync(join(testHome, 'team-protected.txt'), 'PRIVATE_TEAM_CONTENT');
  let parentRound = 0, childRound = 0, childResult;
  const result = await runFixture(t, body => {
    if (body.messages.some(m => String(m.content).includes('【队长 任务指派】'))) {
      if (++childRound === 1) return action('Read', { path: 'team-protected.txt' }, 'team-read');
      childResult = body.messages.find(m => m.role === 'tool')?.content;
      return { content: '子任务结束' };
    }
    if (++parentRound === 1) return action('TeamCreate', { name: 'fixture team' }, 'create-team');
    if (parentRound === 2) return action('AgentCreate', { role: 'reader', goal: 'fixture', agentCreatePermissions: 'explore' }, 'create-worker');
    if (parentRound === 3) {
      const worker = body.messages.find(m => m.role === 'tool' && String(m.content).includes('agent_id:'))?.content;
      const id = String(worker).match(/agent_id:\s*([A-Za-z0-9_-]+)/)?.[1];
      assert.ok(id);
      return action('AgentRun', { agent_id: id, task: 'fixture rules' }, 'run-worker');
    }
    return { content: '完成' };
  }, { sessionId: captain.id, permissionRules: [{ tool_name: 'Read', rule_content: 'team-protected.txt', behavior: 'deny' }] });
  assert.equal(result.done.reason, 'completed');
  assert.equal(childRound, 2);
  assert.match(childResult, /拒绝/);
  assert.ok(!childResult.includes('PRIVATE_TEAM_CONTENT'));
});

test('委派权限视图只含 deny 和 ask，不把父 allow 带给子代理', async t => {
  let delegated;
  const tool = { name: 'InspectPolicy', description: 'fixture', parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => { delegated = ctx.readPermissionRules(); return 'ok'; } };
  const rules = ['allow', 'deny', 'ask'].map(behavior => ({ tool_name: 'Write', behavior }));
  const result = await runFixture(t, (_body, i) => i === 1 ? action('InspectPolicy', {}) : { content: '完成' }, {
    permissionRules: rules, extraTools: [tool],
  });
  assert.equal(result.done.reason, 'completed');
  assert.deepEqual(delegated.map(rule => rule.behavior), ['deny', 'ask']);
});

test('中断同轮批量调用后保留配对结果，读取恢复记录不重放副作用', async t => {
  const controller = new AbortController();
  let executions = 0;
  const tool = { name: 'Probe', description: 'fixture', parameters: { type: 'object', properties: {} },
    execute: async () => { executions++; controller.abort(); return '已执行一次'; } };
  const batch = { content: '', tool_calls: [...action('Probe', {}, 'one').tool_calls, ...action('Probe', {}, 'two').tool_calls] };
  const result = await runFixture(t, () => batch, { extraTools: [tool], signal: controller.signal });
  assert.equal(result.done.reason, 'aborted');
  assert.equal(executions, 1);
  assert.equal(result.requests.length, 1);
  assertCompleteToolGroups(result.messages);
  assert.equal(result.messages.filter(m => m.role === 'tool' && m.tool_state === 'error').length, 1);
  const record = createSessionRecord({ agent_id: 'fixture', toraCfg: { model: 'fixture' } });
  record.internal = result.messages;
  saveSessionRecord(record);
  assertCompleteToolGroups(loadSessionRecord(record.id).internal);
  assert.equal(executions, 1);
});

test('取消挂起的人工确认不会等待永不返回的宿主回调', { timeout: 1500 }, async t => {
  const controller = new AbortController();
  let executions = 0;
  const tool = { name: 'Probe', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => { executions++; return 'ok'; } };
  const result = await runFixture(t, () => action('Probe', {}), {
    extraTools: [tool], permissionMode: 'default', signal: controller.signal,
    permissionAsk: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); },
  });
  assert.equal(result.done.reason, 'aborted');
  assert.equal(result.requests.length, 1);
  assert.equal(executions, 0);
  assertCompleteToolGroups(result.messages);
});

test('用户拒绝的同一调用不反复弹确认，也不会继续执行', async t => {
  let asks = 0, executions = 0;
  const tool = { name: 'Probe', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => { executions++; return 'ok'; } };
  const result = await runFixture(t, () => action('Probe', {}), {
    extraTools: [tool], permissionMode: 'default', maxTurns: 20,
    permissionAsk: async () => { asks++; return { confirmed: false }; },
  });
  assert.equal(result.done.reason, 'error');
  assert.equal(asks, 1);
  assert.equal(executions, 0);
  assert.equal(result.requests.length, 3);
});

test('钩子改写后的实际参数仍需通过工具类型校验', async t => {
  const hook = join(testHome, 'hooks.json');
  const code = "process.stdout.write(JSON.stringify({updatedInput:{value:'bad'}}))";
  writeFileSync(hook, JSON.stringify({ PreToolUse: [{ matcher: 'Probe', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}` }] }));
  t.after(() => rmSync(hook, { force: true }));
  let executions = 0;
  const tool = { name: 'Probe', description: 'fixture', parameters: {
    type: 'object', properties: { value: { type: 'integer' } }, required: ['value'],
  }, execute: async () => { executions++; return 'ok'; } };
  const result = await runFixture(t, (_body, i) => i === 1 ? action('Probe', { value: 1 }) : { content: '已处理失败' }, {
    extraTools: [tool], cfg: { hooksEnabled: true },
  });
  assert.equal(executions, 0);
  assert.equal(result.events.find(e => e.type === 'tool-result').meta.failure.kind, 'invalid-arguments');
});

test('ReAct 返工保持文本工具结果协议，并共享动作额度', async t => {
  let critic = 0, actions = 0, executions = 0;
  const tool = { name: 'Probe', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => { executions++; return 'ok'; } };
  const result = await runFixture(t, body => {
    if (String(body.messages[0]?.content).includes('AI Agent 审查者')) {
      critic++;
      return { content: JSON.stringify({ passed: critic > 1, issues: critic === 1 ? ['需要检查'] : [], reason: 'fixture' }) };
    }
    actions++;
    return { content: actions === 2 ? '```json\n{"tool":"Probe","args":{}}\n```' : '```json\n{"final":"完成"}\n```' };
  }, { extraTools: [tool], maxTurns: 3, cfg: { forceReact: true, review } });
  assert.equal(result.done.reason, 'completed');
  assert.equal(actions, 3);
  assert.equal(executions, 1);
  assert.ok(result.messages.some(m => m.role === 'user' && String(m.content).includes('工具 Probe 的执行结果')));
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 0);
  assertCompleteToolGroups(result.messages);
});

test('复核不能把字符串 false 当作通过', async t => {
  const result = await runFixture(t, body => body.tools ? { content: '完成' }
    : { content: '{"passed":"false","issues":["失败"],"reason":"fixture"}' }, { cfg: { review: { ...review, max_rounds: 0 } } });
  assert.equal(result.done.reason, 'error');
});

test('压缩切口不能拆开同批工具调用和结果', async () => {
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: '旧任务' + 'x'.repeat(4000) },
    { role: 'assistant', content: null, tool_calls: [readCall('a'), readCall('b')] },
    toolReply('a'), toolReply('b'),
    { role: 'assistant', content: 'step done' },
    { role: 'user', content: '继续当前任务' },
    { role: 'assistant', content: null, tool_calls: [readCall('c')] },
    toolReply('c'),
    { role: 'assistant', content: 'done' },
  ];
  assertCompleteToolGroups(messages);
  const result = await compactMessages(messages, { budget: 100, summarize: async () => '已完成旧任务' });
  assert.ok(result.compacted);
  assertCompleteToolGroups(result.messages);
  assert.equal(result.messages.filter(m => m.role === 'system').length, 1);
  assert.ok(result.messages.some(m => m.content === '继续当前任务'));
  assert.equal(messages[1].content.length, 4003);
});

test('长任务反复压缩仍保留真实目标、最近工具组和低信任摘要', async () => {
  const target = { role: 'user', content: '修复库存模块，保留现有接口' };
  let messages = [{ role: 'system', content: 'rules' }, target];
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 5; i++) {
      const id = `${round}-${i}`;
      messages.push({ role: 'assistant', content: null, tool_calls: [readCall(id)] });
      messages.push({ ...toolReply(id), content: '关键进展' + 'x'.repeat(1500) });
    }
    const result = await compactMessages(messages, {
      budget: 500, keepTail: 3, protectedUser: target,
      summarize: async () => '库存修复已完成第一步，仍需验证',
    });
    assert.ok(result.compacted);
    assert.ok(result.messages.some(m => m.role === 'user' && m.content === target.content));
    assert.equal(result.messages.filter(m => m.role === 'system').length, 1);
    assertCompleteToolGroups(result.messages);
    assert.ok(result.messages.some(m => m.tool_call_id === `${round}-4`));
    messages = result.messages;
  }
});

test('空摘要和膨胀摘要退回有界摘录，不虚报压缩进展', async () => {
  for (const summary of ['', 'z'.repeat(30000)]) {
    const messages = [
      { role: 'system', content: 'rules' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', content: `进展 ${i}:` + 'x'.repeat(1000) })),
      { role: 'user', content: '继续验证' },
    ];
    const result = await compactMessages(messages, { budget: 300, keepTail: 1, summarize: async () => summary });
    assert.ok(result.compacted);
    assert.ok(estimateMessagesTokens(result.messages) < estimateMessagesTokens(messages));
    assert.ok(result.messages.some(m => String(m.content).includes('进展')));
    assert.ok(estimateMessagesTokens(result.messages) <= 300);
  }
});

test('压缩保留多模态工具结果与调用配对且不把图片编码塞进摘要', async () => {
  const image = { role: 'tool', tool_call_id: 'image', content: [
    { type: 'text', text: '截图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIVATE_IMAGE' } },
  ] };
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: '早期进展' + 'x'.repeat(5000) },
    { role: 'user', content: '检查截图' },
    { role: 'assistant', content: null, tool_calls: [readCall('image')] }, image,
  ];
  let digest;
  const result = await compactMessages(messages, { budget: 1500, keepTail: 1, summarize: async prompt => { digest = prompt; return '已完成前期检查'; } });
  assert.ok(result.compacted);
  assertCompleteToolGroups(result.messages);
  assert.deepEqual(result.messages.find(m => m.tool_call_id === 'image'), image);
  assert.ok(!digest.includes('PRIVATE_IMAGE'));
});

test('摘要取消必须向上传播，不用硬截断继续请求', async () => {
  const messages = [{ role: 'system', content: 'rules' }, ...Array.from({ length: 9 }, () => ({ role: 'assistant', content: 'x'.repeat(1000) }))];
  const controller = new AbortController();
  await assert.rejects(compactMessages(messages, {
    budget: 100, signal: controller.signal,
    summarize: async () => { controller.abort(); throw Object.assign(new Error('stop'), { code: 'ABORTED' }); },
  }), error => error.code === 'ABORTED');
});

test('受保护目标超预算时不静默丢弃或假报已达预算', async () => {
  const target = { role: 'user', content: '必须保留的需求' + 'x'.repeat(3000) };
  const messages = [{ role: 'system', content: 'rules' }, target, ...Array.from({ length: 9 }, () => ({ role: 'assistant', content: 'y'.repeat(1000) }))];
  const result = await compactMessages(messages, { budget: 100, protectedUser: target, keepTail: 1, summarize: async () => '进展摘要' });
  assert.ok(result.messages.some(m => m.content === target.content));
  assert.equal(result.overBudget, true);
});

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

function taskState(tasks = []) {
  const state = { tasks_context: { tasks: structuredClone(tasks) } };
  let writes = 0;
  return { state, get writes() { return writes; }, read: () => state,
    write(patch) { Object.assign(state, structuredClone(patch)); writes++; } };
}
const taskRecord = (id, state = 'pending', blocked_by = []) => ({ id, state, subject: id,
  description: '', metadata: {}, owner: null, blocks: [], blocked_by, created_at: '2026-11-13T00:00:00Z' });

function installHooks(t, hooks) {
  const path = join(testHome, 'hooks.json');
  const previous = existsSync(path) ? readFileSync(path) : null;
  writeFileSync(path, JSON.stringify(hooks));
  t.after(() => previous ? writeFileSync(path, previous) : rmSync(path, { force: true }));
  return value => writeFileSync(path, JSON.stringify(value));
}
const hookCommand = code => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
async function waitUntil(condition) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Fixture condition did not become observable');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Harness tasks use the real native execution path without a workspace', async t => {
  const state = taskState();
  const steps = [
    { content: '', tool_calls: [...action('TaskCreate', { subject: 'A' }, 'a').tool_calls, ...action('TaskCreate', { subject: 'B' }, 'b').tool_calls] },
    action('TaskUpdate', { taskId: 'T2', addBlockedBy: ['T1'] }),
    action('TaskUpdate', { taskId: 'T1', state: 'in_progress' }),
    action('TaskUpdate', { taskId: 'T1', state: 'completed' }),
    action('TaskUpdate', { taskId: 'T2', state: 'in_progress' }),
    action('TaskUpdate', { taskId: 'T2', state: 'completed' }),
    action('TaskList', {}), action('TaskGet', { taskId: 'T2' }), { content: '完成' },
  ];
  const result = await runFixture(t, (_body, index) => steps[index - 1], { cwd: null, sessionState: state, permissionMode: 'accept_edits' });
  assert.equal(result.done.reason, 'completed');
  assert.equal(result.requests.length, 9);assert.equal(result.done.metrics.toolCalls, 9);
  assert.equal(result.done.metrics.failedToolCalls, 0);assert.equal(state.writes, 7);
  assert.deepEqual(state.state.tasks_context.tasks.map(task => [task.id, task.state]), [['T1', 'completed'], ['T2', 'completed']]);
  assert.deepEqual(state.state.tasks_context.tasks[0].blocks, ['T2']);
  assert.deepEqual(state.state.tasks_context.tasks[1].blocked_by, ['T1']);
  assert.ok(result.messages.some(message => message.role === 'tool' && String(message.content).includes('完成 2')));
  assert.ok(result.events.filter(event => event.type === 'tool-result').every(event => event.ok));
});

test('Harness tasks share the same state channel in ReAct mode', async t => {
  const state = taskState();
  const steps = [ { tool: 'TaskCreate', args: { subject: 'ReAct task' } },
    { tool: 'TaskUpdate', args: { taskId: 'T1', state: 'completed' } }, { tool: 'TaskList', args: {} }, { final: '完成' } ];
  const result = await runFixture(t, (body, index) => {
    assert.equal(body.tools, undefined);
    return { content: JSON.stringify(steps[index - 1]) };
  }, { cwd: null, sessionState: state, cfg: { forceReact: true } });
  assert.equal(result.done.reason, 'completed');assert.equal(result.requests.length, 4);
  assert.equal(state.state.tasks_context.tasks[0].state, 'completed');
  assert.ok(result.messages.some(message => message.role === 'user' && String(message.content).includes('工具 TaskList 的执行结果（成功）')));
});

test('Harness hides unavailable task capabilities in native and ReAct requests', async t => {
  for (const sessionState of [null, {}, { read: () => ({}) }, { write() {} }]) {
    for (const forceReact of [false, true]) {
      const result = await runFixture(t, body => {
        if (forceReact) assert.ok(!body.messages[0].content.includes('TaskCreate'));
        else assert.ok(body.tools.every(tool => !/^Task(?:Create|Update|Get|List)$/.test(tool.function.name)));
        return { content: forceReact ? '{"final":"回答"}' : '回答' };
      }, { sessionState, systemPrompt: 'fixture rules', cfg: { forceReact } });
      assert.equal(result.done.reason, 'completed');assert.equal(result.requests.length, 1);
    }
  }
});

test('Harness task workspace exemption never grants filesystem access or overrides permission', async t => {
  let executed = 0;
  const registry = createToolRegistry([...taskTools, { name: 'Read', description: '', parameters: {}, execute() { executed++; return 'unexpected'; } }], name => name);
  const state = taskState();
  const read = await registry.invoke({ function: { name: 'Read' } }, { requiresWorkspace: false }, { cwd: null, sessionState: state });
  assert.equal(read.ok, false);assert.equal(read.meta.failure.kind, 'requires-workspace');assert.equal(executed, 0);
  for (const mode of ['explore', 'bypass']) {
    const channel = taskState();
    const result = await runFixture(t, (_body, index) => index === 1 ? action('TaskCreate', { subject: 'denied' }) : { content: '已说明限制' }, {
      cwd: null, sessionState: channel, permissionMode: mode,
      permissionRules: mode === 'bypass' ? [{ tool_name: 'TaskCreate', rule_content: '', behavior: 'deny' }] : [],
    });
    assert.equal(channel.writes, 0);assert.equal(result.events.find(event => event.type === 'tool-result').ok, false);
  }
});

test('Harness task writes still require confirmation and respect PreToolUse denial', async t => {
  const state = taskState();let asks = 0;
  const allowed = await runFixture(t, (_body, index) => index === 1 ? action('TaskCreate', { subject: 'confirmed' }) : { content: '计划已列出' }, {
    cwd: null, sessionState: state, permissionMode: 'default', permissionAsk: async () => { asks++; return { confirmed: true }; },
  });
  assert.equal(asks, 1);assert.equal(state.writes, 1);assert.equal(allowed.done.reason, 'completed');
  installHooks(t, { PreToolUse: [{ matcher: 'TaskCreate', command: hookCommand('process.stdout.write(JSON.stringify({decision:"deny",reason:"task hook veto"}))') }] });
  const blocked = taskState();
  const result = await runFixture(t, (_body, index) => index === 1 ? action('TaskCreate', { subject: 'hook denied' }) : { content: '受规则限制' }, {
    cwd: null, sessionState: blocked, cfg: { hooksEnabled: true },
  });
  assert.equal(blocked.writes, 0);assert.equal(result.events.find(event => event.type === 'tool-result').ok, false);
});

test('Harness task validation failures are atomic and dependency transitions stay consistent', async () => {
  const state = taskState();const registry = createToolRegistry(taskTools, name => name);
  const invoke = (name, args) => registry.invoke({ function: { name } }, args, { cwd: null, sessionState: state });
  for (const subject of ['A', 'B', 'C']) assert.equal((await invoke('TaskCreate', { subject })).ok, true);
  await invoke('TaskUpdate', { taskId: 'T2', addBlockedBy: ['T1', 'T1'] });
  let before = structuredClone(state.state), writes = state.writes;
  for (const next of ['in_progress', 'completed']) {
    const failed = await invoke('TaskUpdate', { taskId: 'T2', state: next, subject: 'wrong', owner: 'wrong', metadata: { wrong: true } });
    assert.equal(failed.ok, false);assert.equal(failed.meta.failure.retryable, false);
    assert.deepEqual(state.state, before);assert.equal(state.writes, writes);
  }
  await invoke('TaskUpdate', { taskId: 'T1', state: 'completed' });
  assert.equal((await invoke('TaskUpdate', { taskId: 'T2', state: 'in_progress' })).ok, true);
  before = structuredClone(state.state);writes = state.writes;
  assert.equal((await invoke('TaskUpdate', { taskId: 'T1', state: 'pending' })).ok, false);
  assert.deepEqual(state.state, before);assert.equal(state.writes, writes);
  await invoke('TaskUpdate', { taskId: 'T2', state: 'completed' });
  assert.equal((await invoke('TaskUpdate', { taskId: 'T1', state: 'in_progress' })).ok, false);
  await invoke('TaskUpdate', { taskId: 'T2', state: 'pending' });
  assert.equal((await invoke('TaskUpdate', { taskId: 'T1', state: 'pending' })).ok, true);
  await invoke('TaskUpdate', { taskId: 'T3', addBlockedBy: ['T2'] });
  before = structuredClone(state.state);writes = state.writes;
  for (const args of [{ taskId: 'T1', addBlockedBy: ['T3'] }, { taskId: 'T1', addBlockedBy: ['T1'] }, { taskId: 'T2', state: 'done' }, { taskId: 'T99' }]) {
    const failed = await invoke('TaskUpdate', args);assert.equal(failed.ok, false);assert.equal(failed.meta.failure.retryable, false);
    assert.deepEqual(state.state, before);assert.equal(state.writes, writes);
  }
  assert.deepEqual(state.state.tasks_context.tasks[0].blocks, ['T2']);
  assert.equal((await invoke('TaskUpdate', { taskId: 'T3', owner: null })).ok, true);
  state.state.tasks_context.tasks.push(taskRecord('old', 'completed', ['unready']), taskRecord('unready'));
  assert.equal((await invoke('TaskUpdate', { taskId: 'T1', description: 'unrelated update' })).ok, true);
  assert.equal((await invoke('TaskUpdate', { taskId: 'old', metadata: { note: 'historical' } })).ok, true);
  assert.equal((await invoke('TaskUpdate', { taskId: 'old', state: 'pending' })).ok, true);
});

test('Harness persistence exceptions are not reported as successful task writes or argument errors', async () => {
  const original = { tasks_context: { tasks: [taskRecord('T1')] } };
  const before = structuredClone(original);const registry = createToolRegistry(taskTools, name => name);
  const channel = { read: () => original, write() { throw Error('fixture storage failure'); } };
  for (const [name, args] of [['TaskCreate', { subject: 'new' }], ['TaskUpdate', { taskId: 'T1', subject: 'new title', metadata: { new: true } }]]) {
    const result = await registry.invoke({ function: { name } }, args, { cwd: null, sessionState: channel });
    assert.equal(result.ok, false);assert.match(result.result, /fixture storage failure/);
    assert.equal(result.meta?.failure, undefined);assert.deepEqual(original, before);
  }
});

test('Harness repeated invalid task requests stop instead of pretending success', async t => {
  const state = taskState([taskRecord('T1')]);
  const result = await runFixture(t, (_body, index) => action('TaskUpdate', { taskId: 'missing', state: 'completed' }, `bad-${index}`), { cwd: null, sessionState: state });
  assert.equal(result.done.reason, 'error');assert.equal(result.requests.length, 3);
  assert.equal(result.done.metrics.failedToolCalls, 3);assert.equal(state.writes, 0);
});

test('Harness aborted tasks remain unfinished and later runs read the persisted progress', async t => {
  const state = taskState([taskRecord('T1')]);const controller = new AbortController();
  const interrupted = await runFixture(t, (_body, index) => {
    if (index === 1) return action('TaskUpdate', { taskId: 'T1', state: 'in_progress' });
    controller.abort();throw Object.assign(Error('stop'), { code: 'ABORTED' });
  }, { cwd: null, sessionState: state, signal: controller.signal });
  assert.equal(interrupted.done.reason, 'aborted');assert.equal(state.state.tasks_context.tasks[0].state, 'in_progress');
  const resumed = await runFixture(t, (_body, index) => index === 1 ? action('TaskList', {}) : { content: '当前任务仍在进行' }, { cwd: null, sessionState: state });
  assert.equal(resumed.done.reason, 'completed');assert.ok(resumed.messages.some(message => message.role === 'tool' && String(message.content).includes('[in_progress]')));
  assert.equal(state.writes, 1);assert.equal(resumed.requests.length, 2);
});

test('Harness child runs do not inherit the parent task channel', async t => {
  const state = taskState([taskRecord('T1')]);
  const result = await runFixture(t, (body, index) => {
    const names = body.tools.map(tool => tool.function.name);
    if (index === 1) { assert.ok(names.includes('TaskList'));return action('Subagent', { prompt: '只返回简短结论' }); }
    if (index === 2) assert.ok(!names.includes('TaskList'));
    return { content: index === 2 ? 'child answer' : 'parent answer' };
  }, { sessionState: state });
  assert.equal(result.done.reason, 'completed');assert.equal(result.requests.length, 3);assert.equal(state.writes, 0);
});

test('Harness Stop denial blocks completion without adding model calls', async t => {
  const setHooks = installHooks(t, {});
  for (const command of [hookCommand('process.stdout.write(JSON.stringify({decision:"deny",reason:"verification veto"}))'), hookCommand('process.stderr.write("verification veto");process.exit(2)')]) {
    setHooks({ Stop: [{ command }] });
    const result = await runFixture(t, () => ({ content: '模型声称完成' }), { cfg: { hooksEnabled: true } });
    assert.equal(result.done.reason, 'blocked');assert.match(result.done.error, /verification veto/);
    assert.equal(result.requests.length, 1);assert.equal(result.events.filter(event => event.type === 'done').length, 1);
    assert.equal(result.events.find(event => event.type === 'hook' && event.event === 'Stop').reason, 'verification veto');
  }
});

test('Harness Stop warnings and planning-only pending tasks may finish normally', async t => {
  installHooks(t, { Stop: [{ command: hookCommand('process.stderr.write("fixture warning");process.exit(1)') }] });
  const state = taskState();
  const result = await runFixture(t, (_body, index) => index === 1 ? action('TaskCreate', { subject: 'future work' }) : { content: '这里只提供计划，尚未执行' }, { cwd: null, sessionState: state, cfg: { hooksEnabled: true } });
  assert.equal(result.done.reason, 'completed');assert.equal(state.state.tasks_context.tasks[0].state, 'pending');
  assert.equal(result.requests.length, 2);
  const status = await runFixture(t, () => ({ content: '回答另一个问题' }), { sessionState: state });
  assert.equal(status.done.reason, 'completed');assert.equal(status.requests.length, 1);
});

test('Harness Stop cannot replace existing errors or action limits with another result', async t => {
  installHooks(t, { Stop: [{ command: hookCommand('process.stdout.write(JSON.stringify({decision:"deny",reason:"stop veto"}))') }] });
  const original = await runFixture(t, () => { throw Error('original model failure'); });
  const failed = await runFixture(t, () => { throw Error('original model failure'); }, { cfg: { hooksEnabled: true } });
  assert.equal(failed.done.reason, 'error');assert.equal(failed.done.error, original.done.error);
  const limited = await runFixture(t, () => action('TaskList', {}), { cwd: null, sessionState: taskState(), maxTurns: 1, cfg: { hooksEnabled: true } });
  assert.equal(limited.done.reason, 'max-turns');assert.equal(limited.requests.length, 1);
});

test('Harness cancellation during Stop takes priority over its denial', async t => {
  const controller = new AbortController();const marker = join(testHome, 'stop-started'), release = join(testHome, 'stop-release');
  const code = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write(JSON.stringify({decision:'deny',reason:'late veto'}));}},10)`;
  installHooks(t, { Stop: [{ command: hookCommand(code), timeout: 5 }] });
  t.after(() => { rmSync(marker, { force: true });rmSync(release, { force: true }); });
  const running = runFixture(t, () => ({ content: '完成' }), { signal: controller.signal, cfg: { hooksEnabled: true } });
  try { await waitUntil(() => existsSync(marker));controller.abort(); }
  finally { writeFileSync(release, 'continue'); }
  const result = await running;assert.equal(result.done.reason, 'aborted');assert.equal(result.done.error, undefined);
  assert.equal(result.requests.length, 1);assert.equal(result.events.filter(event => event.type === 'done').length, 1);
});
