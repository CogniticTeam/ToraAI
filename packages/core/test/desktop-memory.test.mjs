import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const home = mkdtempSync(join(tmpdir(), 'tora-desktop-memory-'));
process.env.TORA_HOME = home;
process.env.TORA_BASE_URL = 'https://desktop-memory.fixture.invalid/v1';
process.env.TORA_API_KEY = 'fixture-key';

const { listMemories, saveMemory, deleteMemory, saveMemoryConfig, CONTEXT_BUDGET } = await import('../src/asapi/memory.js');
const { renderDesktopMemoryContext } = await import('../src/asapi/desktop-memory-recall.js');
const { runAgent } = await import('../src/agent.js');
const { memorySearchTool, memoryListTool, memoryForgetTool } = await import('../src/tools/memory.js');
const { startASAPIServer } = await import('../src/asapi/server.js');
const { loadSessionRecord, saveSessionRecord, listAgents } = await import('../src/asapi/store.js');
const { setModelFetcher } = await import('../src/model-transport.js');
const { isRunning } = await import('../src/asapi/bridge.js');

const project = join(realpathSync(home), 'project');
const other = join(realpathSync(home), 'other');
mkdirSync(project);
mkdirSync(other);
after(() => rmSync(home, { recursive: true, force: true }));

function reset() {
  for (const memory of listMemories()) deleteMemory(memory.id);
  saveMemoryConfig({ distill_enabled: false, inject_enabled: true });
}

const completion = content => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } }
);

test('桌面召回按项目隔离，预算内优先使用置顶、全局偏好及相关条目', () => {
  reset();
  saveMemory({ content: '默认用中文回复', kind: 'preference' });
  saveMemory({ content: '部署使用 canary 环境', project_key: project });
  saveMemory({ content: '部署使用另一个项目的发布通道', project_key: other, pinned: true });
  saveMemory({ content: '普通全局背景不随意注入' });
  saveMemory({ content: '发布前准备证据', project_key: project, pinned: true });
  const context = renderDesktopMemoryContext('canary，如何部署？', project);
  assert.match(context, /默认用中文回复/);
  assert.match(context, /部署使用 canary 环境/);
  assert.match(context, /发布前准备证据/);
  assert.doesNotMatch(context, /另一个项目|普通全局背景/);
  assert.doesNotMatch(renderDesktopMemoryContext('部署', ''), /canary|发布前准备证据|另一个项目/);
  assert.doesNotMatch(renderDesktopMemoryContext('你好', project), /canary/);

  for (let index = 0; index < 5; index++) {
    saveMemory({ content: `目录 ${index} ${'发布'.repeat(900)}`, pinned: true }, { desktop: true });
  }
  assert.ok(renderDesktopMemoryContext('部署', project).length <= CONTEXT_BUDGET);
  assert.ok(renderDesktopMemoryContext('部署', project, 520).length <= 520);
});

test('桌面记忆工具按会话项目读取及删除，自动提炼保留手动内容', async () => {
  reset();
  const toolContext = { cwd: other, desktopMemory: { projectKey: project } };
  const visible = saveMemory({ content: '采用 vite 打包', project_key: project }).memory;
  const privateMemory = saveMemory({ content: '采用 vite 构建客户代码', project_key: other, pinned: true }).memory;
  assert.match(await memorySearchTool.execute({ query: 'Vite?' }, toolContext), /vite 打包/);
  assert.match(await memorySearchTool.execute({ query: 'vi' }, toolContext), /vite 打包/);
  assert.doesNotMatch(await memorySearchTool.execute({ query: 'Vite?' }, toolContext), /客户代码/);
  assert.doesNotMatch(await memoryListTool.execute({}, toolContext), /客户代码/);
  assert.match(await memoryForgetTool.execute({ id: privateMemory.id }, toolContext), /没有 id/);
  assert.match(await memoryForgetTool.execute({ id: visible.id }, toolContext), /已删除/);
  assert.ok(listMemories().some(memory => memory.id === privateMemory.id));

  const original = saveMemory({ content: '上线审批必需', kind: 'convention', source: 'manual', pinned: true }, { desktop: true }).memory;
  const origin = { session_id: 'source', message_id: 'user' };
  const duplicate = saveMemory({ content: '上线审批必需。', kind: 'fact', source: 'distill' }, { desktop: true, origin });
  assert.equal(duplicate.deduped, true);
  assert.deepEqual(duplicate.memory, original);
  const distinct = saveMemory({ content: '上线审批非必需', kind: 'fact', source: 'distill' }, { desktop: true, origin });
  assert.notEqual(distinct.memory.id, original.id);
});

test('桌面 Agent 的全局偏好适用于无目录会话，开关只控制自动注入', async () => {
  reset();
  saveMemory({ content: '默认给出简洁答复', kind: 'preference' });
  const runs = [];
  setModelFetcher(async (_url, options) => {
    runs.push(JSON.parse(options.body));
    return completion('完成');
  });
  try {
    const capture = async (cfg = {}) => {
      const messages = [{ role: 'user', content: '你好' }];
      const opts = { messages, desktopMemory: { query: '你好' }, cfg: {
        model: 'fixture', baseURL: process.env.TORA_BASE_URL, apiKey: 'fixture-key',
        injectProjectContext: false, hooksEnabled: false, ...cfg,
      } };
      for await (const event of runAgent(opts)) {
        if (event.type === 'done') assert.equal(event.reason, 'completed', event.error);
      }
      assert.doesNotMatch(messages[0].content, /默认给出简洁答复/);
      return runs.at(-1).messages[0].content;
    };
    assert.match(await capture(), /默认给出简洁答复/);
    assert.doesNotMatch(await capture({ appMode: 'tochat', tochatMode: 'chat' }), /默认给出简洁答复/);
    saveMemoryConfig({ inject_enabled: false });
    assert.doesNotMatch(await capture(), /默认给出简洁答复|记忆使用指引/);
  } finally {
    setModelFetcher(null);
  }
});

test('桌面 ASAPI 每轮召回，并把合格提炼关联到现有来源消息', async () => {
  reset();
  const srv = await startASAPIServer({ desktopMemory: true });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const agent = listAgents()[0];
  const requests = [];
  let replyToDistill = () => completion(JSON.stringify([
    { content: '必须先运行发布检查', kind: 'convention', quote: '必须先运行发布检查' },
    { content: '助手臆测的命令', kind: 'fact', quote: '助手臆测的命令' },
  ]));
  setModelFetcher(async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return body.messages[0].content.includes('原子记忆') ? replyToDistill() : completion('助手臆测的命令');
  });
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const result = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(result.status, 200, path);
    return result.json();
  };
  const waitFor = async check => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await delay(20);
    }
    assert.fail('后台运行未在预期时间内完成');
  };
  try {
    const { session_id: sessionId } = await api('/sessions/', { agent_id: agent.id, cwd: project, model_source: 'custom' });
    const session = loadSessionRecord(sessionId);
    session.config.naming = { auto: false };
    saveSessionRecord(session);
    const chat = text => api('/chat/', {
      agent_id: agent.id, session_id: sessionId,
      input: { content: [{ type: 'text', text }] },
      auto_context: [{ type: 'text', text: 'hiddenmarker' }],
    });
    await api('/memories', { content: 'vite 开发命令', scope: 'project', project_key: project });
    await api('/memories', { content: 'canary 发布环境', scope: 'project', project_key: project });
    await api('/memories', { content: 'hiddenmarker 专属条目' });
    await api('/memories', { content: '另一项目的 canary', scope: 'project', project_key: other, pinned: true });

    await chat('如何启动 vite？');
    await waitFor(() => !isRunning(sessionId));
    assert.match(requests[0].messages[0].content, /vite 开发命令/);
    assert.doesNotMatch(requests[0].messages[0].content, /canary 发布环境|hiddenmarker 专属条目/);
    assert.equal(requests.length, 1);

    await api('/memory-config', { distill_enabled: true });
    const sourceText = 'canary 部署前必须先运行发布检查。';
    await chat(sourceText);
    await waitFor(() => !isRunning(sessionId) && listMemories().some(memory => memory.source === 'distill'));
    assert.match(requests[1].messages[0].content, /canary 发布环境/);
    assert.doesNotMatch(requests[1].messages[0].content, /vite 开发命令|另一项目的 canary/);
    assert.doesNotMatch(loadSessionRecord(sessionId).internal[0].content, /canary 发布环境/);
    const distilled = listMemories().filter(memory => memory.source === 'distill');
    assert.equal(distilled.length, 1);
    const [memory] = distilled;
    assert.equal(memory.project_key, project);
    assert.equal(memory.origin.session_id, sessionId);
    assert.deepEqual(await api(`/memories/${memory.id}/origin`), { origin: { text: sourceText } });
    assert.deepEqual(
      (await api(`/memories?q=canary&scope=project&project_key=${encodeURIComponent(project)}`)).memories.map(item => item.content),
      ['canary 发布环境']
    );

    let release;
    replyToDistill = () => new Promise(resolve => { release = resolve; });
    const lateSource = '只允许工作日执行发布';
    await chat(lateSource);
    await waitFor(() => release && !isRunning(sessionId));
    const lateUser = loadSessionRecord(sessionId).display.filter(message => message.role === 'user').at(-1);
    await api(`/sessions/${sessionId}/messages/${lateUser.id}`, undefined, 'DELETE');
    release(completion(JSON.stringify([{ content: lateSource, kind: 'convention', quote: lateSource }])));
    await api(`/sessions/${sessionId}/messages/${memory.origin.message_id}`, undefined, 'DELETE');
    assert.deepEqual(await api(`/memories/${memory.id}/origin`), { origin: null });
    assert.ok(!listMemories().some(item => item.content === lateSource));
    const edited = await api(`/memories/${memory.id}`, { content: '先核对发布清单' }, 'PATCH');
    assert.equal(edited.memory.source, 'manual');
    assert.equal(edited.memory.origin, undefined);
  } finally {
    setModelFetcher(null);
    await new Promise(resolve => srv.close(resolve));
  }
});
