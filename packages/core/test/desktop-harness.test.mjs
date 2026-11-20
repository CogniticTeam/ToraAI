import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const home = mkdtempSync(join(tmpdir(), 'tora-desktop-harness-'));
process.env.TORA_HOME = home;

const { decidePermission, runAgent } = await import('../src/agent.js');
const { startASAPIServer } = await import('../src/asapi/server.js');
const { isRunning } = await import('../src/asapi/bridge.js');
const { createAgent, createSessionRecord, listAgents, loadSessionRecord, saveSessionRecord } = await import('../src/asapi/store.js');
const { readSessionEvents } = await import('../src/asapi/session-events.js');
const { sessionToolOutputs } = await import('../src/asapi/tool-outputs.js');
const { loadConfig, saveConfig } = await import('../src/config.js');
const { setModelFetcher } = await import('../src/model-transport.js');
const { registerSecret } = await import('../src/security.js');
const { listCheckpoints } = await import('../src/tools/checkpoint.js');

const cfg = {
  baseURL: 'https://desktop-harness.invalid/v1', apiKey: 'fixture', model: 'deepseek-harness-fixture',
  injectProjectContext: false, hooksEnabled: false, checkpointEnabled: false, shellSandbox: false,
  persistentShell: false, permissionRules: [], mcpServers: {}, forceReact: false, toolOutputLimit: 6000,
  maxTokensBudget: 24000,
};
let server;
let base;
let integrationCalls;
let externalCalls;
const externalTool = {
  name: 'mcp__fixture__echo', description: 'Returns a test message', parameters: { type: 'object' },
  async execute() { externalCalls++; return 'echoed'; },
};

before(async () => {
  const plugins = { skillContext() { return ''; }, async mcpTools() { integrationCalls++; return [externalTool]; } };
  server = await startASAPIServer({ desktopHarness: true, desktopPlugins: plugins });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  setModelFetcher(null);
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

function session({ cwd = null, mode = 'default', config = {}, agent = listAgents()[0], ...runConfig } = {}) {
  saveConfig({ ...cfg, ...runConfig });
  const record = createSessionRecord({
    toraCfg: loadConfig(), agent_id: agent.id, cwd,
    chat_model_config: { type: 'openai_compatible', credential_id: '', model: cfg.model, parameters: { thinking: false } },
  });
  Object.assign(record.config, { naming: { auto: false }, ...config });
  record.state.permission_mode = mode;
  return saveSessionRecord(record);
}

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const tools = (...tool_calls) => ({ content: '', tool_calls });
const reply = content => ({ content });
const names = request => request.tools?.map(tool => tool.function.name) ?? [];

function model(respond) {
  const requests = [];
  setModelFetcher(async (url, init) => {
    assert.ok(url.startsWith(cfg.baseURL));
    const request = JSON.parse(init.body);
    requests.push(request);
    const answer = await respond(request, requests.length);
    if (answer instanceof Response) return answer;
    return Response.json({
      choices: [{ message: { role: 'assistant', ...answer } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
  });
  return requests;
}

const jsonRequest = (url, method, value) => fetch(url, {
  method, ...(value === undefined ? {} : {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  }),
});

async function send(record, text, endpoint = base) {
  const response = await jsonRequest(`${endpoint}/chat/`, 'POST', {
    session_id: record.id, agent_id: record.agent_id,
    input: { content: [{ type: 'text', text }] },
  });
  assert.equal(response.status, 200, await response.text());
}

async function settledReply(record) {
  const deadline = Date.now() + 5000;
  while (isRunning(record.id) && Date.now() < deadline) await delay(15);
  assert.equal(isRunning(record.id), false, 'desktop run did not settle');
  return loadSessionRecord(record.id).display.at(-1);
}

async function run(record, text) {
  await send(record, text);
  return settledReply(record);
}

const resume = (record, replyId) => jsonRequest(
  `${base}/sessions/${record.id}/resume?agent_id=${record.agent_id}`, 'POST',
  { reply_id: replyId, view_mode: 'tocode' },
);

test('desktop first request is smaller and starts without loading integrations', async t => {
  const record = session({ cwd: home });
  integrationCalls = 0;
  const requests = model(() => reply('完成'));
  const full = [];
  for await (const event of runAgent({
    cfg: { ...cfg, thinking: false }, messages: [{ role: 'user', content: '普通问题' }], cwd: home,
  })) full.push(event);

  const result = await run(record, '普通问题');
  const oldMetrics = full.at(-1).metrics;
  const current = result.metadata.harness.metrics;
  assert.equal(result.finished_reason, 'completed');
  assert.equal(integrationCalls, 0);
  assert.equal(requests.length, 2);
  assert.ok(names(requests[1]).includes('Bash'));
  assert.ok(!names(requests[1]).includes('Computer'));
  assert.match(requests[1].messages[0].content, /The workspace is already selected/);
  assert.match(requests[1].messages[0].content, /send independent file reads together/);
  assert.ok(!requests[1].messages[0].content.includes(home));
  assert.ok(current.firstToolTokens < oldMetrics.firstToolTokens * 0.65);
  assert.equal(current.modelCalls, 1);
  assert.ok(Number.isSafeInteger(current.modelWaitMs));
  assert.equal(current.toolBatchMs, 0);
  t.diagnostic(`tool definitions ${oldMetrics.firstRequestTools} → ${current.firstRequestTools}; estimated tokens ${oldMetrics.firstToolTokens} → ${current.firstToolTokens}`);
});

test('discovery appends tools in order, loads integrations once, and keeps the real permission gate', async () => {
  const record = session({ cwd: home, permissionRules: [
    { tool_name: externalTool.name, behavior: 'deny' },
  ] });
  externalCalls = integrationCalls = 0;
  const requests = model((_request, number) => {
    if (number === 1) return tools(call('browser', 'ToolSearch', { query: 'Browser' }));
    if (number === 2) return tools(call('integration', 'ToolSearch', { query: 'echo', scope: 'integrations' }));
    if (number === 3) return tools(call('again', 'ToolSearch', { query: 'echo', scope: 'integrations' }));
    if (number === 4) return tools(call('denied', externalTool.name));
    return reply('流程结束');
  });
  const result = await run(record, '发现工具并遵守权限');
  assert.equal(result.finished_reason, 'completed');
  assert.equal(integrationCalls, 1);
  assert.equal(externalCalls, 0);
  assert.deepEqual(names(requests[1]), [...names(requests[0]), 'Browser']);
  assert.deepEqual(names(requests[2]), [...names(requests[1]), externalTool.name]);
  assert.deepEqual(names(requests[3]), names(requests[2]));
  assert.match(requests[4].messages.at(-1).content, /命中用户禁用规则/);
  assert.equal(result.metadata.harness.metrics.deniedToolCalls, 1);
});

test('ReAct discovers schemas while ordinary ToChat stays web-only', async () => {
  const react = session({ cwd: home, forceReact: true });
  const requests = model((_request, number) => reply(number === 1
    ? '```json\n{"tool":"ToolSearch","args":{"query":"Browser"}}\n```' : '完成'));
  assert.equal((await run(react, '查找浏览器工具')).finished_reason, 'completed');
  assert.equal(requests[0].tools, undefined);
  assert.match(requests[1].messages.at(-1).content, /参数：\{"type":"object".*"action"/s);

  const chat = session({ cwd: home, config: { application_mode: 'tochat', task_mode: 'chat', model_source: 'custom' } });
  integrationCalls = 0;
  const chatRequests = model(() => reply('聊天回复'));
  assert.equal((await run(chat, '你好')).finished_reason, 'completed');
  assert.deepEqual(names(chatRequests[0]).sort(), ['WebFetch', 'WebSearch']);
  assert.doesNotMatch(chatRequests[0].messages[0].content, /The workspace is already selected/);
  assert.equal(integrationCalls, 0);
});

test('a live permission update takes effect after the first tool warms the reader', async () => {
  const cwd = mkdtempSync(join(home, 'permission-latency-'));
  writeFileSync(join(cwd, 'existing.txt'), 'read first');
  const record = session({ cwd, mode: 'accept_edits' });
  const requests = model(async (_request, number) => {
    if (number === 1) return tools(call('read-warmup', 'Read', { path: 'existing.txt' }));
    if (number === 2) {
      const update = await jsonRequest(`${base}/sessions/${record.id}`, 'PATCH', { permission_mode: 'explore' });
      assert.equal(update.status, 200);
      return tools(call('must-deny', 'Write', { path: 'unauthorized.txt', content: 'should not appear' }));
    }
    return reply('已按当前权限结束');
  });
  const finished = await run(record, '核对当前权限');
  assert.equal(finished.finished_reason, 'completed');
  assert.match(requests[2].messages.at(-1).content, /explore/);
  assert.equal(finished.metadata.harness.metrics.deniedToolCalls, 1);
  assert.deepEqual(readdirSync(cwd), ['existing.txt']);
});

test('desktop approval modes distinguish web access, workspace edits and risky actions', () => {
  const work = { desktopApprovals: true };
  const decide = (mode, name, args = {}, rules = []) => decidePermission(mode, name, args, rules, work).behavior;
  assert.equal(decide('default', 'Read', { path: 'a.js' }), 'allow');
  assert.equal(decide('default', 'Write', { path: 'a.js' }), 'ask');
  assert.equal(decide('default', 'WebSearch', { query: 'test' }), 'ask');
  assert.equal(decide('default', 'WebFetch', { url: 'https://example.invalid' }), 'ask');
  assert.equal(decide('default', 'Browser', { action: 'new_tab' }), 'allow');
  assert.equal(decide('default', 'Browser', { action: 'new_tab', url: 'https://example.invalid' }), 'ask');
  assert.equal(decide('accept_edits', 'Edit', { path: 'a.js' }), 'allow');
  assert.equal(decide('accept_edits', 'Browser', { action: 'read' }), 'allow');
  assert.equal(decide('accept_edits', 'Browser', { action: 'click' }), 'ask');
  assert.equal(decide('accept_edits', 'Git', { subcommand: 'push' }), 'ask');
  assert.equal(decide('accept_edits', 'Checkpoint', { action: 'restore' }), 'ask');
  assert.equal(decide('bypass', 'Bash'), 'allow');
  assert.equal(decide('bypass', 'Bash', {}, [{ tool_name: 'Bash', behavior: 'deny' }]), 'deny');
  assert.equal(decide('explore', 'Write'), 'deny');
  assert.equal(decide('dont_ask', 'Bash'), 'deny');
});

test('a refused website request returns to the desktop model as a denied tool call', async () => {
  model((_body, number) => number === 1
    ? tools(call('fetch-site', 'WebFetch', { url: 'https://example.invalid' }))
    : reply('已结束'));
  const confirmations = [];
  const events = [];
  for await (const event of runAgent({
    cfg: { ...cfg, thinking: false }, cwd: home, desktopHarness: true, permissionMode: 'default',
    messages: [{ role: 'user', content: '打开网页' }],
    permissionAsk: async ({ name }) => { confirmations.push(name); return { confirmed: false }; },
  })) events.push(event);
  assert.deepEqual(confirmations, ['WebFetch']);
  assert.match(events.find(event => event.type === 'tool-result')?.result, /用户拒绝/);
});

test('only the current request gets changing workspace context; the system prefix stays stable', async () => {
  const cwd = mkdtempSync(join(home, 'project-'));
  execFileSync('git', ['init', '-q', cwd]);
  writeFileSync(join(cwd, 'AGENTS.md'), 'Keep the project conventions.');
  const record = session({ cwd, injectProjectContext: true, repoMapInject: false, changesAware: true });
  const requests = model(() => reply('完成'));
  await run(record, '第一条任务');
  writeFileSync(join(cwd, 'new-file.js'), 'export const sample = 1;');
  await run(record, '第二条任务');
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
  assert.match(requests[1].messages[0].content, /Keep the project conventions/);
  assert.equal(requests[1].messages[1].content, '第一条任务');
  assert.match(requests[1].messages.at(-1).content, /第二条任务[\s\S]*new-file\.js/);
  assert.doesNotMatch(JSON.stringify(loadSessionRecord(record.id).internal), /本轮工作环境与召回资料/);
});

test('provider context rejection compacts and retries once with the same goal and tool protocol', async () => {
  const record = session({ cwd: home });
  record.internal = [
    ...Array.from({ length: 8 }, (_, i) => [
      { role: 'user', content: `旧任务 ${i}` },
      { role: 'assistant', content: '旧结果 '.repeat(300) },
    ]).flat(),
    { role: 'assistant', content: '', tool_calls: [call('previous-read', 'Read', { path: 'a.js' })] },
    { role: 'tool', tool_call_id: 'previous-read', content: '最近的工具结果' },
  ];
  saveSessionRecord(record);
  const rejection = () => Response.json({ error: { code: 'context_length_exceeded', message: 'The model maximum context length includes tools' } }, { status: 400 });
  const requests = model((_request, number) => number === 1 ? rejection() : reply('恢复成功'));
  const result = await run(record, '保留这个任务目标');
  assert.equal(result.finished_reason, 'completed');
  assert.equal(requests.length, 2);
  assert.deepEqual(names(requests[0]), names(requests[1]));
  assert.ok(JSON.stringify(requests[1].messages).length < JSON.stringify(requests[0].messages).length);
  assert.equal(requests[1].messages.at(-1).content, '保留这个任务目标');
  assert.equal(requests[1].messages.find(message => message.tool_call_id === 'previous-read')?.content, '最近的工具结果');
  assert.equal(result.metadata.harness.metrics.contextRetries, 1);

  const short = session({ cwd: home });
  const failedRequests = model(rejection);
  assert.equal((await run(short, '保留请求')).finished_reason, 'error');
  assert.equal(failedRequests.length, 1);
});

test('Bash keeps a bounded preview and a private, paged archive across forks', async () => {
  const secret = 'fixture-private-value-never-store';
  registerSecret(secret);
  const cwd = mkdtempSync(join(home, 'output-'));
  const fileText = `${'A'.repeat(3500)}\nMIDDLE_🧪 ${secret} END_MIDDLE\n${'Z'.repeat(3500)}`;
  writeFileSync(join(cwd, 'log.txt'), fileText);
  const agent = createAgent({ name: 'Short output fixture', context_config: { tool_result_limit: 640 } });
  const record = session({ cwd, agent });
  let id;
  const requests = model((request, number) => {
    if (number === 1) return tools(call('bash-result', 'Bash', { command: 'cat log.txt' }));
    if (number === 2) {
      const text = request.messages.at(-1).content;
      id = /id: ([\w-]+)/.exec(text)?.[1];
      if (id) return tools(call('output-page', 'ToolOutput', { id, offset: 3500, limit: 150 }));
    }
    return reply('已读取中段');
  });
  const finished = await run(record, '查看日志中段');
  assert.equal(finished.finished_reason, 'completed', finished.error?.message);
  const preview = requests[1].messages.at(-1).content;
  assert.ok(preview.length <= 640, preview);
  assert.match(preview, /exit_code: 0\nA+/);
  assert.match(preview, /Z+$/);
  assert.doesNotMatch(preview, /MIDDLE/);
  assert.ok(id, preview);
  assert.match(requests[2].messages.at(-1).content, /MIDDLE_🧪 .*END_MIDDLE/);
  assert.doesNotMatch(sessionToolOutputs(record.id).read(id), /fixture-private-value-never-store/);
  assert.equal(finished.metadata.harness.metrics.archivedOutputs, 1);
  assert.ok(readSessionEvents(record.id).events.some(event => event.type === 'internal-append'));

  const fork = await jsonRequest(`${base}/sessions/${record.id}/fork`, 'POST', { name: '保留日志的分支' });
  assert.equal(fork.status, 200);
  const branch = loadSessionRecord((await fork.json()).session_id);
  const foreign = session();
  assert.equal(sessionToolOutputs(foreign.id).read(id), null);
  assert.equal((await jsonRequest(`${base}/sessions/${record.id}`, 'DELETE')).status, 200);
  assert.equal(sessionToolOutputs(record.id).read(id), null);
  assert.match(sessionToolOutputs(branch.id).read(id), /MIDDLE_🧪/);
});

test('a dispatched persistent shell command is never run again after the shell exits', async () => {
  const cwd = mkdtempSync(join(home, 'shell-'));
  const record = session({ cwd, persistentShell: true, mode: 'bypass' });
  const requests = model((_request, number) => number === 1
    ? tools(call('drop-shell', 'Bash', { command: 'printf x >> executions; exit 7' }))
    : reply('执行状态需核对'));
  assert.equal((await run(record, '执行一次')).finished_reason, 'completed');
  assert.equal(readFileSync(join(cwd, 'executions'), 'utf8'), 'x');
  assert.match(requests[1].messages.at(-1).content, /^exit_code: 7\b/);
});

test('a mandatory Stop check prevents a completed reply when its command fails', async () => {
  const record = session({ cwd: home, hooksEnabled: true });
  const file = join(home, 'hooks.json');
  writeFileSync(file, JSON.stringify({ Stop: [{ required: true, command: 'exit 1' }] }));
  try {
    const requests = model(() => reply('模型声称已完成'));
    const finished = await run(record, '检查完成状态');
    assert.equal(finished.error.type, 'blocked');
    assert.equal(finished.metadata.harness.reason, 'blocked');
    assert.match(finished.error.message, /完成校验未通过/);
    assert.equal(requests.length, 1);
  } finally { rmSync(file, { force: true }); }
});

test('a trusted completion check reports a real failure, lets the agent repair once, and verifies the new file', async () => {
  const cwd = mkdtempSync(join(home, 'verify-'));
  const resultPath = join(cwd, 'result.txt');
  writeFileSync(resultPath, 'wrong\n');
  const validator = join(cwd, 'check.cjs');
  const secret = 'fixture-verifier-secret-value';
  registerSecret(secret);
  writeFileSync(validator, `
    const fs = require('node:fs');
    const run = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.appendFileSync('attempts.log', JSON.stringify(run.stop_hook_active) + '\\n');
    if (fs.readFileSync('result.txt', 'utf8') !== 'fixed\\n') {
      process.stderr.write('EXPECTED_FIXED ${secret}');
      process.exitCode = 1;
    }
  `);
  const hooks = join(home, 'hooks.json');
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(validator)}`;
  writeFileSync(hooks, JSON.stringify({ Stop: [{ required: true, repair: true, command }] }));
  try {
    const record = session({ cwd, mode: 'accept_edits', hooksEnabled: true });
    const requests = model((_body, number) => {
      if (number === 1) return reply('初次候选答复');
      if (number === 2) return tools(call('fix-result', 'Write', { path: 'result.txt', content: 'fixed\n' }));
      return reply('结果已修复并通过校验');
    });
    const finished = await run(record, '修复结果文件并通过独立检查');
    assert.equal(finished.finished_reason, 'completed', finished.error?.message);
    assert.equal(readFileSync(resultPath, 'utf8'), 'fixed\n');
    assert.equal(readFileSync(join(cwd, 'attempts.log'), 'utf8'), 'false\ntrue\n');
    assert.equal(finished.metadata.harness.metrics.verificationRepairs, 1);
    assert.equal(requests.length, 3);
    assert.match(requests[1].messages.at(-1).content, /EXPECTED_FIXED/);
    assert.doesNotMatch(JSON.stringify(requests), /fixture-verifier-secret-value/);
    assert.ok(requests[2].messages.some(message => message.role === 'user' && message.content === '修复结果文件并通过独立检查'));
  } finally { rmSync(hooks, { force: true }); }
});

test('completion repair stays bounded and cannot override an explicit Stop denial or the turn budget', async () => {
  const file = join(home, 'hooks.json');
  try {
    const stalled = session({ cwd: home, hooksEnabled: true });
    writeFileSync(file, JSON.stringify({ Stop: [{ required: true, repair: true, command: 'exit 1' }] }));
    const failedRequests = model(() => reply('No real change'));
    const failed = await run(stalled, '检查持续失败');
    assert.equal(failed.error.type, 'blocked');
    assert.equal(failedRequests.length, 2);
    assert.equal(failed.metadata.harness.metrics.verificationRepairs, 1);

    const limited = session({
      cwd: home, hooksEnabled: true,
      agent: createAgent({ name: 'Limited verifier', react_config: { max_iters: 1 } }),
    });
    const limitedRequests = model(() => reply('无剩余动作预算'));
    const exhausted = await run(limited, '检查动作预算');
    assert.equal(exhausted.error.type, 'blocked');
    assert.equal(exhausted.metadata.harness.metrics.verificationRepairs, 0);
    assert.equal(limitedRequests.length, 1);

    const denied = session({ cwd: home, hooksEnabled: true });
    writeFileSync(file, JSON.stringify({ Stop: [{ required: true, repair: true, command: 'echo "policy veto" >&2; exit 2' }] }));
    const deniedRequests = model(() => reply('检查策略拒绝'));
    const blocked = await run(denied, '保持硬拒绝');
    assert.match(blocked.error.message, /policy veto/);
    assert.equal(blocked.error.type, 'blocked');
    assert.equal(deniedRequests.length, 1);
  } finally { rmSync(file, { force: true }); }
});

test('file edits refuse stale reads and preserve literal replacements, line endings, and existing mode', async () => {
  const cwd = mkdtempSync(join(home, 'edit-'));
  const path = join(cwd, 'script.js');
  const original = 'function demo() {\r\n  return "before";\r\n}\r\n';
  const external = '// edited in IDE\r\n' + original;
  const replacement = 'function demo() {\n  return "$& $$";\n}';
  writeFileSync(path, original);
  chmodSync(path, 0o755);
  const record = session({ cwd, mode: 'accept_edits' });
  const edit = { path: 'script.js', old_string: original.trim().replace(/\r\n/g, '\n'), new_string: replacement };
  const requests = model((_body, number) => {
    if (number === 1 || number === 3) return tools(call(`read-${number}`, 'Read', { path: 'script.js' }));
    if (number === 2) writeFileSync(path, external);
    if (number === 2 || number === 4) return tools(call(`edit-${number}`, 'Edit', edit));
    return reply('检查了当前文件后完成编辑');
  });
  assert.equal((await run(record, '保留现有文件和外部改动')).finished_reason, 'completed');
  assert.match(requests[2].messages.at(-1).content, /文件已发生变化.*Read/);
  assert.match(requests[3].messages.at(-1).content, /edited in IDE/);
  assert.equal(readFileSync(path, 'utf8'), '// edited in IDE\r\n' + replacement.replace(/\n/g, '\r\n') + '\r\n');
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.ok(readdirSync(cwd).every(file => !file.startsWith('.tora-write-')));
});

test('a denied or invalid write does not create a checkpoint before the admitted mutation', async () => {
  const cwd = mkdtempSync(join(home, 'checkpoint-'));
  const record = session({ cwd, mode: 'accept_edits', checkpointEnabled: true, permissionRules: [
    { tool_name: 'Write', rule_content: 'blocked.txt', behavior: 'deny' },
  ] });
  const checks = [];
  model((_body, number) => {
    if (number > 1) checks.push(listCheckpoints(record.id).length);
    if (number === 1) return tools(call('deny-write', 'Write', { path: 'blocked.txt', content: 'denied' }));
    if (number === 2) return tools(call('invalid-write', 'Write', { path: 'valid.txt', content: false }));
    if (number === 3) return tools(call('allowed-write', 'Write', { path: 'valid.txt', content: 'allowed\n' }));
    return reply('状态已核对');
  });
  assert.equal((await run(record, '运行受控写入')).finished_reason, 'completed');
  assert.deepEqual(checks, [0, 0, 1]);
  assert.equal(readFileSync(join(cwd, 'valid.txt'), 'utf8'), 'allowed\n');
  assert.ok(!readdirSync(cwd).includes('blocked.txt'));
});

test('a fresh desktop process recovers an interrupted batch without repeating external side effects', { timeout: 10000 }, async t => {
  const cwd = mkdtempSync(join(home, 'recovery-'));
  const effect = join(cwd, 'side-effect');
  writeFileSync(join(cwd, 'known.txt'), 'already read the file');
  const record = session({ cwd, mode: 'bypass' });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { appendFileSync } from 'node:fs';
    import { startASAPIServer } from ${JSON.stringify(new URL('../src/asapi/server.js', import.meta.url).href)};
    import { setModelFetcher } from ${JSON.stringify(new URL('../src/model-transport.js', import.meta.url).href)};
    const action = ${call.toString()};
    let requests = 0;
    setModelFetcher(async () => Response.json({ choices: [{ message: {
      role: 'assistant', content: '', tool_calls: ++requests === 1
        ? [action('search', 'ToolSearch', { query: 'fixture', scope: 'integrations' })]
        : [action('known', 'Read', { path: 'known.txt' }), action('pending', 'FixturePause')],
    } }] }));
    const plugins = { skillContext() { return ''; }, async mcpTools() { return [{
      name: 'FixturePause', description: 'Test an interrupted tool', parameters: { type: 'object' },
      async execute() {
        appendFileSync(${JSON.stringify(effect)}, 'once');
        process.send('side effect happened');
        await new Promise(() => {});
      },
    }]; } };
    const server = await startASAPIServer({ desktopHarness: true, desktopPlugins: plugins });
    process.send(server.address().port);
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); });
  const [port] = await once(child, 'message');
  const paused = once(child, 'message');
  await send(record, '开始原始任务', `http://127.0.0.1:${port}`);
  assert.equal((await paused)[0], 'side effect happened');
  const stopped = once(child, 'exit');
  child.kill('SIGKILL');
  await stopped;

  const prior = loadSessionRecord(record.id);
  assert.equal(prior.internal.at(-1).tool_call_id, 'known');
  assert.equal(prior.display.at(-1).finished_at, null);
  const priorReply = prior.display.at(-1);
  assert.equal((await resume(record, 'stale-reply')).status, 409);
  const requests = model(() => reply('已核对之前的执行状态'));
  assert.equal((await resume(record, priorReply.id)).status, 202);
  const result = await settledReply(record);
  assert.equal(result.finished_reason, 'completed');
  assert.equal(requests.length, 1);
  const messages = requests[0].messages;
  assert.ok(messages.some(message => message.role === 'user' && message.content === '开始原始任务'));
  assert.match(messages.at(-1).content, /保留原始目标和约束/);
  assert.match(messages.find(message => message.tool_call_id === 'known')?.content, /already read the file/);
  assert.match(messages.find(message => message.tool_call_id === 'pending')?.content, /执行结果未知/);
  const saved = loadSessionRecord(record.id);
  assert.equal(saved.display.at(-2).finished_reason, 'interrupted');
  assert.equal(saved.display.filter(message => message.role === 'user').length, 1);
  assert.equal(result.metadata.resumed_from, priorReply.id);
  assert.equal((await resume(record, priorReply.id)).status, 409);
  assert.equal(readFileSync(effect, 'utf8'), 'once');
});

test('resuming at the turn limit keeps the original goal through another compaction', async () => {
  const record = session({
    cwd: home, agent: createAgent({ name: 'One-turn fixture', react_config: { max_iters: 1 } }),
  });
  const goal = 'Validate the inventory CSV and preserve the column order.';
  model(() => tools(call('list', 'TaskList')));
  const unfinished = await run(record, goal);
  assert.equal(unfinished.finished_reason, 'exceed_max_iters');

  const saved = loadSessionRecord(record.id);
  saved.internal.push(...Array.from({ length: 8 }, (_, index) => ({
    role: 'assistant', content: `Progress ${index}\n${'Detailed history '.repeat(250)}`,
  })));
  saved.internal.push({ role: 'user', harness_feedback: true, content: 'Latest diagnostic, not the objective' });
  saveSessionRecord(saved);
  saveConfig({ maxTokensBudget: 5800 });
  const requests = model(request => reply(request.tools ? '验收通过' : 'Retain progress and the outstanding check.'));
  assert.equal((await resume(record, unfinished.id)).status, 202);
  const complete = await settledReply(record);
  assert.equal(complete.finished_reason, 'completed');
  assert.equal(complete.metadata.harness.metrics.compactions, 1);
  const action = requests.find(request => request.tools);
  assert.ok(action?.messages.some(message => message.role === 'user' && message.content === goal));
  assert.match(action?.messages.at(-1).content, /执行结果未知/);
  assert.equal(loadSessionRecord(record.id).display.filter(message => message.role === 'user').length, 1);
});
