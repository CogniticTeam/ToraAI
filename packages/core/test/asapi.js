// ASAPI 协议适配层集成测试（mock 模型 SSE，验证 agentscope 前端所需全链路）
// 运行：node packages/core/test/asapi.js
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 独立测试环境：把数据根整体重定向到临时目录。
// 早期版本直接 rmSync(~/.vega/asapi) —— 那会删掉用户真实的
// agents/会话/凭证/技能库，跑一次测试毁一次数据。
const TEST_HOME = join(tmpdir(), `cocode-asapi-test-${Date.now()}`);
process.env.COCODE_HOME = TEST_HOME;
const ASAPI_DIR = join(TEST_HOME, 'asapi');

const { startASAPIServer } = await import('../src/asapi/server.js');
const { realpathAllowMissing } = await import('../src/security.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// mock SSE 模型：第1轮调工具，第2轮总结
function sse(chunks) {
  const events = chunks.map((c) => ({ choices: [{ delta: c }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  events.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const payload = 'data: ' + events.map((e) => JSON.stringify(e)).join('\ndata: ') + '\ndata: [DONE]\n\n';
  return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// AI 自动取名（title.js）会在 Agent 开工前先发一次模型调用。它不是被测
// 行为，mock 必须识别并跳过 —— 否则所有"第 N 次调用"计数被取名请求吞掉，
// 会连锁炸掉十几个用例（模型轮次错位、prompt 断言对到了取名请求上）。
// 返回空正文：generateTitle 对空输出返回 null，会话保留占位标题，
// 与各测试里"断言标题=首条消息截断"的预期一致。
const isTitleCall = (init) => {
  try {
    const body = JSON.parse(init?.body || '{}');
    return (body.messages || []).some(
      (m) => typeof m.content === 'string' && m.content.includes('起一个简短标题')
    );
  } catch { return false; }
};

const realFetch = globalThis.fetch;
let fetchCalls = [];

async function main() {
  process.env.VEGA_API_KEY = 'test-key';
  const srv = await startASAPIServer({ port: 0 });
  const base = `http://127.0.0.1:${srv.address().port}`;

  console.log('--- 基础与 Agent ---');
  let r = await realFetch(base + '/health');
  assert.equal((await r.json()).status, 'ok');

  let agentId;
  await test('agent 列表（自动创建默认 Corey）', async () => {
    const r = await realFetch(base + '/agent/');
    const data = await r.json();
    assert.equal(data.total, 1);
    assert.equal(data.agents[0].data.name, 'Corey');
    assert.ok(data.agents[0].data.context_config.tool_result_limit > 0);
    agentId = data.agents[0].id;
  });

  await test('agent schema v2（表单分区）', async () => {
    const r = await realFetch(base + '/agent/schema/v2');
    const { schema } = await r.json();
    for (const k of ['name', 'system_prompt', 'context_config', 'react_config', 'invite_config']) {
      assert.ok(schema.properties[k], `缺少 ${k}`);
    }
    assert.equal(schema.properties.system_prompt.format, 'textarea');
  });

  await test('agent 创建/更新/删除', async () => {
    let r = await realFetch(base + '/agent/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '测试Agent', system_prompt: '你是测试' })
    });
    const { agent_id } = await r.json();
    r = await realFetch(base + `/agent/${agent_id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '改名' })
    });
    assert.equal((await r.json()).data.name, '改名');
    r = await realFetch(base + `/agent/${agent_id}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    r = await realFetch(base + '/agent/');
    assert.equal((await r.json()).total, 1); // 默认 Corey 还在
  });

  console.log('--- 凭证与模型（自接入）---');
  let credId;
  await test('凭证 schema + 创建 + 模型列表', async () => {
    const r = await realFetch(base + '/credential/schemas');
    const { schemas } = await r.json();
    assert.equal(schemas[0].properties.type.const, 'openai_compatible');
    const r2 = await realFetch(base + '/credential/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { type: 'openai_compatible', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-x' } })
    });
    const { credential_id } = await r2.json();
    credId = credential_id;
    const r3 = await realFetch(base + '/model/?provider=openai_compatible');
    const { models } = await r3.json();
    // 有启用模型列表时用列表（可能 1+ 项），否则退回内置默认集（4 项）
    assert.ok(models.length >= 1);
    assert.ok(models.every((mm) => mm.type === 'chat_model'));
  });

  console.log('--- 会话与聊天（SSE 全链路）---');
  let sessionId;
  await test('会话创建 + 列表（SessionView 形状）', async () => {
    const r = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id } = await r.json();
    sessionId = session_id;
    const r2 = await realFetch(base + `/sessions/?agent_id=${agentId}`);
    const { sessions, total } = await r2.json();
    assert.equal(total, 1);
    const sv = sessions[0];
    assert.equal(sv.session.id, session_id);
    assert.equal(sv.status, 'idle');
    assert.equal(sv.session.origin.type, 'user');
    assert.ok(sv.session.config.chat_model_config.model);
    assert.equal(sv.team, null);
    // internal/display 不外泄
    assert.equal(sv.session.internal, undefined);
    assert.equal(sv.session.display, undefined);
    // 准备一个临时 cwd；agent.js 现在拒绝 cwd 为空的会话（避免回退到 CoCode 根）
    const chatTmpDir = join(tmpdir(), `vega-asapi-chat-${sessionId}`);
    mkdirSync(chatTmpDir, { recursive: true });
    await realFetch(base + `/sessions/${sessionId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: chatTmpDir })
    });
  });

  // 该用例不测权限：显式切到 bypass，避免把"echo 是否只读自动放行"变成隐性依赖
  await realFetch(base + `/sessions/${sessionId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ permission_mode: 'bypass' })
  });

  // mock 模型
  globalThis.fetch = async (u, init) => {
    if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路
    fetchCalls.push(String(u));
    if (fetchCalls.length === 1) {
      return sse([{ tool_calls: [{ index: 0, id: 't1', function: { name: 'bash', arguments: '{"command":"echo hello-asapi"}' } }] }]);
    }
    return sse([{ content: '任务完成：已执行命令' }]);
  };

  await test('POST /chat 触发 → SSE 流 → AgentEvent 协议', async () => {
    // 先开 SSE 订阅（与前端一致：页面加载即连接）
    const ac = new AbortController();
    const sseRes = await realFetch(base + `/sessions/${sessionId}/stream?agent_id=${agentId}`, { signal: ac.signal });
    assert.ok(sseRes.headers.get('content-type').startsWith('text/event-stream'));
    const events = [];
    const reader = sseRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readSome = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const timeout = Math.max(1, deadline - Date.now());
        const p = Promise.race([reader.read(), new Promise((r2) => setTimeout(() => r2({ timeout: true }), timeout))]);
        const { done, value, timeout: timedOut } = await p;
        if (timedOut) return;
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
          }
        }
      }
    };

    // 触发聊天
    const chatRes = await realFetch(base + '/chat/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId, session_id: sessionId,
        input: {
          id: 'u1', name: 'user', role: 'user',
          content: [{ type: 'text', id: 'b1', text: '执行 echo hello-asapi', created_at: new Date().toISOString() }],
          metadata: {}, created_at: new Date().toISOString(), finished_at: new Date().toISOString()
        }
      })
    });
    assert.equal((await chatRes.json()).status, 'ok');

    await readSome(1500);
    ac.abort();

    const types = events.map((e) => e.type);
    // 事件序列符合协议。AI 自动取名"先取名后开工"：标题定稿会先广播一条
    // CUSTOM session_updated，因此首事件可能是 CUSTOM，REPLY_START 紧随其后。
    const iReplyStart = types.indexOf('REPLY_START');
    assert.ok(iReplyStart >= 0, '应有 REPLY_START');
    assert.ok(types.slice(0, iReplyStart).every((t) => t === 'CUSTOM'),
      'REPLY_START 之前只允许 CUSTOM（取名定稿的 session_updated）');
    const rs = events[iReplyStart];
    assert.equal(rs.session_id, sessionId);
    assert.equal(rs.role, 'assistant');
    assert.ok(types.includes('MODEL_CALL_START'));
    assert.ok(types.includes('TOOL_CALL_START'));
    const tcs = events.find((e) => e.type === 'TOOL_CALL_START');
    assert.equal(tcs.tool_call_name, 'Bash');
    const tcd = events.filter((e) => e.type === 'TOOL_CALL_DELTA').map((e) => e.delta).join('');
    assert.deepEqual(JSON.parse(tcd), { command: 'echo hello-asapi' });
    assert.ok(types.includes('TOOL_RESULT_TEXT_DELTA'));
    const trEnd = events.find((e) => e.type === 'TOOL_RESULT_END');
    assert.equal(trEnd.state, 'success');
    assert.ok(types.includes('TEXT_BLOCK_START') && types.includes('TEXT_BLOCK_END'));
    const replyEnd = events.find((e) => e.type === 'REPLY_END');
    assert.equal(replyEnd.finished_reason, 'completed');
    // MODEL_CALL_END 带 usage
    const mcEnds = events.filter((e) => e.type === 'MODEL_CALL_END');
    assert.equal(mcEnds.length, 2); // 两轮
    assert.equal(mcEnds[0].input_tokens, 10);
    // 会话更新通知
    assert.ok(events.some((e) => e.type === 'CUSTOM' && e.name === 'session_updated'));
  });

  globalThis.fetch = realFetch;
  fetchCalls = [];

  await test('历史接口返回 agentscope Msg[]（user + assistant 归并）', async () => {
    const r = await realFetch(base + `/sessions/${sessionId}/messages?agent_id=${agentId}`);
    const { messages, is_running, has_more } = await r.json();
    assert.equal(is_running, false);
    assert.equal(has_more, false);
    assert.equal(messages.length, 2);
    const [u, a] = messages;
    assert.equal(u.role, 'user');
    assert.equal(u.content[0].text, '执行 echo hello-asapi');
    assert.equal(a.role, 'assistant');
    assert.equal(a.name, 'assistant');
    const blockTypes = a.content.map((b) => b.type).join(',');
    assert.ok(blockTypes.includes('tool_call'));
    assert.ok(blockTypes.includes('tool_result'));
    assert.ok(blockTypes.includes('text'));
    const trb = a.content.find((b) => b.type === 'tool_result');
    assert.match(trb.output[0].text, /hello-asapi/);
    assert.equal(trb.state, 'success');
    assert.equal(a.finished_reason, undefined);
    // 会话自动命名
    const r2 = await realFetch(base + `/sessions/?agent_id=${agentId}`);
    const sv = (await r2.json()).sessions[0];
    assert.equal(sv.session.config.name, '执行 echo hello-asapi');
  });

  await test('auto_context 注入 LLM 但不入用户视角历史（display/internal 分离）', async () => {
    // 1) 建一个干净会话（避免与上面那条只跑过一轮的 sessionId 共用历史）
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const tmpCwd = join(tmpdir(), `vega-asapi-autocontext-${sid}`);
    mkdirSync(tmpCwd, { recursive: true });
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpCwd })
    });

    // 2) mock 模型：第一轮空回（只想看入参），结束后 offload。一个回合足够。
    const seenBodies = [];
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路，不进 seenBodies
      try { seenBodies.push(JSON.parse(init?.body || '{}')); } catch { /* ignore */ }
      return sse([{ content: 'OK' }]);
    };

    // 仅记录真正的反压错误：SSE 流被 ac.abort() 时 in-flight 的 reader.read()
    // 可能抛 AbortError。这个 promise 已经不会被 await，跳掉即可，不要让它挂在
    // 全局 unhandledRejection 上炸掉整个测试进程。
    const swallowAbort = (p) => p.catch((e) => {
      if (e?.name !== 'AbortError' && e?.code !== 'ABORT_ERR') throw e;
    });

    try {
      const ac = new AbortController();
      const sseRes = await realFetch(base + `/sessions/${sid}/stream?agent_id=${agentId}`, { signal: ac.signal });
      const reader = sseRes.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const drain = async (ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const left = Math.max(1, deadline - Date.now());
          const { done, value } = await Promise.race([
            swallowAbort(reader.read()),
            new Promise((r2) => setTimeout(() => r2({ value: undefined, done: false }), left)),
          ]);
          if (done) return;
          if (value) buf += dec.decode(value, { stream: true });
        }
      };

      const userText = '请用一句话总结';
      const ctxText = '[Loaded context]\n- CWD: ' + tmpCwd + '\n- Skills: 无\n';
      const ctxBlock = { type: 'text', id: 'ctx-1', text: ctxText, created_at: new Date().toISOString() };
      const resp = await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          session_id: sid,
          input: {
            id: 'u1', name: 'user', role: 'user',
            content: [{ type: 'text', id: 'b1', text: userText, created_at: new Date().toISOString() }],
            metadata: {}, created_at: new Date().toISOString(), finished_at: new Date().toISOString()
          },
          auto_context: [ctxBlock]
        })
      });
      assert.equal((await resp.json()).status, 'ok');
      await drain(2000);
      ac.abort();

      // 3) LLM 看到了合成文本：context 段在前、用户文本在后。
      const firstCall = seenBodies[0];
      assert.ok(firstCall, 'LLM call 未被录制');
      const msgs = firstCall.messages || [];
      const userTurns = msgs.filter((m) => m.role === 'user');
      assert.equal(userTurns.length, 1, '应只有一条用户回合');
      const combined = userTurns[0].content;
      assert.match(combined, /\[Loaded context\]/);
      assert.match(combined, /CWD:/);
      assert.ok(combined.includes(userText), '用户原文也应在 LLM prompt 里');

      // 4) 用户视角历史（display）只看到用户原文——一次也不能出现 "[Loaded context]"。
      const hist = await realFetch(base + `/sessions/${sid}/messages?agent_id=${agentId}`);
      const { messages } = await hist.json();
      assert.equal(messages.length, 2); // user + assistant
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content[0].text, userText);
      assert.ok(!messages[0].content[0].text.includes('[Loaded context]'),
        'display 中不应出现 [Loaded context] 前缀');

      // 5) 收尾：删掉这个会话，避免影响后面"DELETE 后 total=0"的断言。
      const del = await realFetch(base + `/sessions/${sid}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('selected_skill_ids 落进 display metadata，且不泄漏进 LLM prompt', async () => {
    // 技能 chip 的还原完全依赖这条 metadata —— 不落盘的话刷新页面 chips 就没了。
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();

    const seenBodies = [];
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路，不进 seenBodies
      try { seenBodies.push(JSON.parse(init?.body || '{}')); } catch { /* ignore */ }
      return sse([{ content: 'done' }]);
    };

    try {
      const resp = await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          session_id: sid,
          input: { content: [{ type: 'text', text: '帮我审一下' }] },
          auto_context: [{ type: 'text', text: '[Loaded context]\n\n### code-review\n\n审查 diff' }],
          selected_skill_ids: ['sk-a', 'sk-b'],
        })
      });
      assert.equal((await resp.json()).status, 'ok');

      // 给后台 run 一点时间把 assistant 那条也写进 display。
      await new Promise((r2) => setTimeout(r2, 600));

      const hist = await realFetch(base + `/sessions/${sid}/messages?agent_id=${agentId}`);
      const { messages } = await hist.json();
      const u = messages.find((m) => m.role === 'user');
      assert.ok(u, '应有一条 user 消息');
      assert.deepEqual(u.metadata?.selected_skill_ids, ['sk-a', 'sk-b'],
        '技能 id 必须落盘到 metadata，否则刷新后气泡 chips 消失');
      // display 依然干净：技能正文只在 internal
      assert.equal(u.content[0].text, '帮我审一下');
      assert.ok(!JSON.stringify(u.content).includes('审查 diff'));

      // 但 id 本身不该出现在 LLM 看到的 prompt 里（技能正文才是给模型的）
      const prompt = JSON.stringify(seenBodies[0]?.messages ?? []);
      assert.ok(!prompt.includes('sk-a'), 'selected_skill_ids 不应作为裸 id 泄漏进 prompt');
      assert.ok(prompt.includes('审查 diff'), '技能正文应通过 auto_context 进 prompt');

      await realFetch(base + `/sessions/${sid}`, { method: 'DELETE' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });


  await test('selected_skill_ids 落进 display metadata，且不泄漏进 LLM prompt', async () => {
    // 技能 chip 的还原完全依赖这条 metadata —— 不落盘的话刷新页面 chips 就没了。
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();

    const seenBodies = [];
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路，不进 seenBodies
      try { seenBodies.push(JSON.parse(init?.body || '{}')); } catch { /* ignore */ }
      return sse([{ content: 'done' }]);
    };

    try {
      const resp = await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          session_id: sid,
          input: { content: [{ type: 'text', text: '帮我审一下' }] },
          auto_context: [{ type: 'text', text: '[Loaded context]\n\n### code-review\n\n审查 diff' }],
          selected_skill_ids: ['sk-a', 'sk-b'],
        })
      });
      assert.equal((await resp.json()).status, 'ok');

      // 给后台 run 一点时间把 assistant 那条也写进 display。
      await new Promise((r2) => setTimeout(r2, 600));

      const hist = await realFetch(base + `/sessions/${sid}/messages?agent_id=${agentId}`);
      const { messages } = await hist.json();
      const u = messages.find((m) => m.role === 'user');
      assert.ok(u, '应有一条 user 消息');
      assert.deepEqual(u.metadata?.selected_skill_ids, ['sk-a', 'sk-b'],
        '技能 id 必须落盘到 metadata，否则刷新后气泡 chips 消失');
      // display 依然干净：技能正文只在 internal
      assert.equal(u.content[0].text, '帮我审一下');
      assert.ok(!JSON.stringify(u.content).includes('审查 diff'));

      // 但 id 本身不该出现在 LLM 看到的 prompt 里（技能正文才是给模型的）
      const prompt = JSON.stringify(seenBodies[0]?.messages ?? []);
      assert.ok(!prompt.includes('sk-a'), 'selected_skill_ids 不应作为裸 id 泄漏进 prompt');
      assert.ok(prompt.includes('审查 diff'), '技能正文应通过 auto_context 进 prompt');

      await realFetch(base + `/sessions/${sid}`, { method: 'DELETE' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });


  await test('会话 PATCH permission_mode 同时落到 state.permission_context.mode', async () => {
    // 在跑权限模式被切换的回归：前端通过 SSE state_updated + PermissionPanel + useEffect 同步
    // 都从 state.permission_context.mode 读取；老 store 把 mode 平铺在 state.permission_mode 上，
    // PATCH 之后 view refetch 回来，selectedPermissionMode 又被 effect 同步回到 'default'，
    // 看起来"权限模式没切换"。修法是后端 PATCH 同时写两个字段。
    const r = await realFetch(base + `/sessions/${sessionId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permission_mode: 'accept_edits' })
    });
    const rec = await r.json();
    assert.equal(rec.state.permission_mode, 'accept_edits');
    assert.equal(rec.state.permission_context?.mode, 'accept_edits');
    // 切回 default
    await realFetch(base + `/sessions/${sessionId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permission_mode: 'default' })
    });
  });

  await test('会话 PATCH 重命名 / DELETE', async () => {
    let r = await realFetch(base + `/sessions/${sessionId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '手工命名' })
    });
    const rec = await r.json();
    assert.equal(rec.config.name, '手工命名');
    assert.equal(rec.config.naming.auto, false);
    // 删除后列表为空
    r = await realFetch(base + `/sessions/${sessionId}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    r = await realFetch(base + `/sessions/?agent_id=${agentId}`);
    assert.equal((await r.json()).total, 0);
  });

  await test('上下文自动压缩：压缩后 display 记录仍完整（tool_call/tool_result 不丢）', async () => {
    // 1) 建会话 + 设 cwd
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const cwdDir = join(tmpdir(), `vega-asapi-compact-${sid}`);
    mkdirSync(cwdDir, { recursive: true });
    // 该用例测上下文压缩，不测权限：命令里带管道（复合命令），default 会弹确认
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permission_mode: 'bypass' })
    });
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: cwdDir })
    });

    // 2) 把预算压到很小，保证多轮工具输出后必定触发压缩；结束后还原
    const origRuntime = await (await realFetch(base + '/admin/runtime')).json();
    await realFetch(base + '/admin/runtime', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxTokensBudget: 2000 })
    });

    // 3) mock 模型：3 轮工具调用（长输出）后收尾；摘要调用按请求体识别
    let toolRounds = 0;
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路
      let isSummary = false;
      try {
        const body = JSON.parse(init?.body || '{}');
        isSummary = (body.messages || []).some(
          (m) => typeof m.content === 'string' && m.content.includes('压缩为一份高密度纪要')
        );
      } catch { /* ignore */ }
      if (isSummary) return sse([{ content: '【纪要】已执行多轮命令。' }]);
      toolRounds++;
      if (toolRounds <= 5) {
        return sse([{ tool_calls: [{ index: 0, id: 'k' + toolRounds, function: { name: 'bash', arguments: JSON.stringify({ command: `head -c 3000 /dev/zero | tr '\\0' 'y'` }) } }] }]);
      }
      return sse([{ content: '全部完成' }]);
    };

    try {
      const ac = new AbortController();
      const sseRes = await realFetch(base + `/sessions/${sid}/stream?agent_id=${agentId}`, { signal: ac.signal });
      const events = [];
      const reader = sseRes.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const readSome = async (ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const timeout = Math.max(1, deadline - Date.now());
          const p = Promise.race([reader.read(), new Promise((r2) => setTimeout(() => r2({ timeout: true }), timeout))]);
          const { done, value, timeout: timedOut } = await p;
          if (timedOut || done) return;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
          }
        }
      };

      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '跑三轮' }] } })
      });
      await readSome(3000);
      ac.abort();

      // 4) 压缩事件已广播（前端据此弹提示）
      const compactEv = events.find((e) => e.type === 'CUSTOM' && e.name === 'context_compacted');
      assert.ok(compactEv, '应广播 CUSTOM context_compacted 事件');
      assert.equal(typeof compactEv.value.tokensBefore, 'number');
      assert.equal(typeof compactEv.value.budget, 'number');

      // 5) display 记录完整：压缩发生在 internal 上，不能殃及本轮 display
      const hist = await (await realFetch(base + `/sessions/${sid}/messages?agent_id=${agentId}`)).json();
      assert.equal(hist.messages.length, 2, '一条 user + 一条 assistant');
      const a = hist.messages[1];
      assert.equal(a.role, 'assistant');
      const kinds = a.content.map((b) => b.type);
      assert.equal(kinds.filter((k) => k === 'tool_call').length, 5, '五次工具调用都要在 display 里');
      assert.equal(kinds.filter((k) => k === 'tool_result').length, 5, '五次工具结果都要在 display 里');
      assert.ok(kinds.includes('text'));
      for (const trb of a.content.filter((b) => b.type === 'tool_result')) {
        assert.ok(trb.output[0].text.length > 0, '工具结果内容不能为空');
      }
      // 收尾文本落在最后一个 text 块
      const lastText = [...a.content].reverse().find((b) => b.type === 'text');
      assert.equal(lastText.text, '全部完成');
    } finally {
      globalThis.fetch = realFetch;
      await realFetch(base + '/admin/runtime', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(origRuntime)
      });
      await realFetch(base + `/sessions/${sid}`, { method: 'DELETE' });
    }
  });

  await test('Agent 运行行为（/admin/runtime）：压缩预算 + 工具输出 + 迭代轮数', async () => {
    // config.json 是用户真实配置（~/.vega/config.json），测试只做往返断言，
    // 结束后还原原值 —— 不能假设初始值，否则会被上一次运行或用户改动影响。
    const r0 = await realFetch(base + '/admin/runtime');
    const original = await r0.json();
    assert.equal(r0.status, 200);
    assert.equal(typeof original.maxTokensBudget, 'number');
    assert.equal(typeof original.toolOutputLimit, 'number');
    assert.equal(typeof original.maxTurns, 'number');

    try {
      // 合法 PATCH 往返
      const patch = await realFetch(base + '/admin/runtime', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxTokensBudget: 8000, toolOutputLimit: 4000, maxTurns: 20 })
      });
      const after = await patch.json();
      assert.equal(patch.status, 200);
      assert.equal(after.maxTokensBudget, 8000);
      assert.equal(after.toolOutputLimit, 4000);
      assert.equal(after.maxTurns, 20);
      // GET 落地一致
      const re = await (await realFetch(base + '/admin/runtime')).json();
      assert.equal(re.maxTokensBudget, 8000);
      assert.equal(re.toolOutputLimit, 4000);
      assert.equal(re.maxTurns, 20);

      // 越界值被夹回合法区间（2000..200000 / 200..50000 / 1..200）
      const clamp = await realFetch(base + '/admin/runtime', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxTokensBudget: 1, toolOutputLimit: 9999999, maxTurns: 0 })
      });
      const c = await clamp.json();
      assert.equal(c.maxTokensBudget, 2000);
      assert.equal(c.toolOutputLimit, 50000);
      assert.equal(c.maxTurns, 1);

      // 空 body 应 400
      const empty = await realFetch(base + '/admin/runtime', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(empty.status, 400);
    } finally {
      // 还原用户原配置
      await realFetch(base + '/admin/runtime', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(original)
      });
    }
  });


  console.log('--- stub 页面 ---');
  await test('空态端点形状', async () => {
    for (const [path, check] of [
      ['/schedule/', (d) => Array.isArray(d.schedules)],
      ['/channels/types', (d) => Array.isArray(d)],
      ['/channels/', (d) => Array.isArray(d)],
      ['/hub/mcp', (d) => Array.isArray(d)],
      ['/hub/skill', (d) => Array.isArray(d)],
      ['/skill', (d) => Array.isArray(d)],
      ['/mcp', (d) => Array.isArray(d)],
      ['/knowledge_bases/', (d) => Array.isArray(d.knowledge_bases)]
    ]) {
      const r = await realFetch(base + path);
      assert.equal(r.status, 200, path);
      check(await r.json());
    }
  });

  await test('workspace 目录列表（未选工作目录时不回退 CoCode 根）', async () => {
    // 新建一个 session 但不 PATCH cwd —— 老逻辑会回退 process.cwd()，
    // 暴露 CoCode 包根的文件树。新逻辑在 cwd 为空时直接返回 null+空列表。
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: noCwdSid } = await mk.json();

    // 1) 工作目录为空时：status 与 directories 都必须诚实返回 null，
    //    而不是回退 process.cwd()（那会把 CoCode 包根的文件树暴露成默认工作区）
    const r3a = await realFetch(base + `/workspace/status?agent_id=x&session_id=${noCwdSid}`);
    const stA = await r3a.json();
    assert.equal(stA.workdir, null, '未选工作目录时不应回退 CoCode 包根');
    assert.equal(stA.cwd, null);
    assert.equal(stA.git, null);

    const r = await realFetch(base + `/workspace/directories?agent_id=x&session_id=${noCwdSid}`);
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.path, null);
    assert.deepEqual(d.entries, []);
    assert.equal(d.needsCwd, true);

    // 2) PATCH 一个临时 cwd 后，列表不再"空"也不暴露 CoCode 根，而是落回
    //    用户选的目录（这里用 tmp 内置子目录的绝对路径）。
    const tmpDir = join(tmpdir(), `vega-asapi-ws-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'in-workspace.txt'), 'hi');
    await realFetch(base + `/sessions/${noCwdSid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpDir })
    });
    const r2 = await realFetch(base + `/workspace/directories?agent_id=x&session_id=${noCwdSid}`);
    const d2 = await r2.json();
    assert.equal(d2.path, tmpDir);
    assert.ok(d2.entries.some((e) => e.name === 'in-workspace.txt'),
      '应能看到刚写入的文件，证明工作目录就是 session.cwd，不是 CoCode 根');

    // status 里的路径是 realpath 归一化过的（macOS 上 /var → /private/var），
    // 所以比对前也要归一化，否则会被符号链接差异误伤
    const st = await (await realFetch(base + `/workspace/status?agent_id=x&session_id=${noCwdSid}`)).json();
    assert.equal(realpathAllowMissing(st.workdir), realpathAllowMissing(tmpDir));
    assert.equal(realpathAllowMissing(st.cwd), realpathAllowMissing(tmpDir));
    assert.ok(st.git && st.git.is_repo === false, 'git 字段应是真实探测结果（该目录不是仓库）');
  });


  // ─────────────────────────────────────────────────────────────
  // SkillHub 技能中心：hub 列表 / 卡片列表 / 详情 / 安装 / 本地库
  // 上游 api.skillhub.cn 用 globalThis.fetch 打桩（本地请求仍走 realFetch）。
  // ─────────────────────────────────────────────────────────────
  console.log('--- SkillHub 技能中心 ---');

  // 打桩状态：让个别用例可以切到「上游 500」。
  let upstreamMode = 'ok';
  const upstreamCalls = [];

  // ── 上游两种真实响应形状（curl 实测）──────────────────────────────
  // list：扁平结构，计数字段是 number，作者叫 ownerName，版本叫 version。
  /** 上游硬编码的每页条数：`limit` 参数被忽略，永远返 20。 */
  const UPSTREAM_PAGE_SIZE = 20;
  const UPSTREAM_LIST = {
    code: 0,
    message: 'success',
    data: {
      total: 149522,
      skills: [
        {
          slug: 'pdf-reader',
          name: 'PDF Reader',
          description: 'Read and parse PDF documents',
          description_zh: '读取和解析 PDF 文档',
          category: 'document',
          tags: null,
          subCategories: [{ name: '文档处理' }],
          downloads: 949690,
          installs: 75956,
          stars: 1747,
          updated_at: 1789227234980,
          ownerName: 'jason',
          version: '1.2.0',
          homepage: 'https://skillhub.cn/pdf-reader',
          iconUrl: 'https://cdn.example.com/pdf.png',
          score: 9.5,
        },
        {
          slug: 'code-review93',
          name: 'code-review93',
          displayName: 'Code Review',
          description: 'Review diffs automatically',
          description_zh: '自动审查代码改动',
          category: 'dev',
          tags: ['dev'],
          subCategories: [{ name: '代码审查' }],
          downloads: 12,
          installs: 3,
          updated_at: 1789227234980,
          ownerName: 'dev',
          version: '1.0.0',
        },
        {
          // 同 slug 的第二个条目。上游列表里确实存在这种「同名不同 namespace」
          // 的行（skillhub 实测见过一页里两条同名）。适配器必须按 id 去重：
          // 否则前端 key 撞车，而且"这一页没有新内容"的判定会把它当成重复页、
          // 提前掐断翻页。
          slug: 'pdf-reader',
          name: 'PDF Reader (社区版)',
          description: 'Community fork of the PDF reader',
          category: 'document',
          tags: null,
          downloads: 3,
          installs: 0,
          ownerName: 'someone-else',
          version: '0.9.0',
        },
      ],
    },
  };

  // detail：信封 { skill, latestVersion, owner }，字段名和类型都与 list 不同 ——
  // 计数是「字符串数字」，时间戳是「毫秒字符串」，描述叫 summary/summary_zh，
  // 正文叫 overviewMd。写死同一份 JSON 会让这些差异逃过测试。
  const UPSTREAM_DETAIL = {
    'pdf-reader': {
      slug: 'pdf-reader',
      skill: {
        slug: 'pdf-reader',
        displayName: 'PDF 阅读器',
        summary: 'Read and parse PDF documents',
        summary_zh: '读取和解析 PDF 文档',
        category: 'document',
        tags: {},
        subCategories: [{ name: '文档处理' }],
        stats: { installs: '56', downloads: '1101', stars: '5' },
        updatedAt: '1789227210438',
        overviewMd: '# PDF Reader\n\n用 `pdftotext` 抽取正文。',
        iconUrl: 'https://cdn.example.com/pdf.png',
        source: 'enterprise',
      },
      latestVersion: { version: '1.3.15' },
      owner: { displayName: '杨科' },
    },
    'code-review93': {
      slug: 'code-review93',
      skill: {
        slug: 'code-review93',
        displayName: 'Code Review',
        summary: 'Review diffs automatically',
        summary_zh: '自动审查代码改动',
        stats: { installs: '3', downloads: '12' },
        updatedAt: '1789227210438',
        overviewMd: '# Code Review\n\n审查 diff 并输出建议。',
      },
      latestVersion: { version: '1.0.0' },
      owner: { displayName: 'dev' },
    },
  };

  // ── OpenAgentSkill 上游（同一个 mock 里分域名处理）────────────────
  // 目录项：字段名与 SkillHub 完全不同 —— name 是展示名、没有独立 slug 名、
  // 计数在 stats 里、正文要自己合成。
  const OAS_CATALOG = {
    total: 2,
    skills: [
      {
        slug: 'anthropic-frontend-design',
        name: 'Frontend Design',
        description: 'Guidance for distinctive UI design',
        long_description: 'A long-form paragraph about typography and visual direction.',
        tagline: 'Design built for agents',
        category: 'design-creative',
        tags: ['agent-skill', 'ui', 'ux'],
        author: 'anthropics',
        verified: true,
        stats: { stars: 175874, verified_installs: 31, downloads: null },
        quality: { score: 100, tier: 'excellent' },
        trust: { score: 96, label: 'Production candidate' },
        safety: { score: 81, label: 'Review before install' },
        platforms: ['Claude Code', 'Codex'],
        install: 'npx skills add anthropics/skills --skill frontend-design',
        repository: 'https://github.com/anthropics/skills/tree/main/skills/frontend-design',
        version: 'Unknown',
        license: 'Source terms (see LICENSE.txt)',
        urls: { detail: 'https://www.openagentskill.com/skills/anthropic-frontend-design' },
      },
      {
        slug: 'crawl4ai',
        name: 'Crawl4AI',
        description: 'LLM-friendly web crawler',
        long_description: 'Crawls sites into markdown.',
        category: 'web-automation',
        tags: ['web-crawling'],
        author: 'unclecode',
        verified: false,
        stats: { stars: 12000, verified_installs: 5 },
        quality: { score: 60 },
        install: 'npx skills add unclecode/crawl4ai',
        version: '1.0.0',
        urls: { detail: 'https://www.openagentskill.com/skills/crawl4ai' },
      },
    ],
  };

  const OAS_RESOLVE = {
    task: '抓取网页内容',
    agent: 'codex',
    recommendation: { install: { command: 'npx skills add topoteretes/cognee' } },
    selected: {
      rank: 1,
      match_score: 52,
      skill: { slug: 'topoteretes-cognee', name: 'Cognee', description: 'AI memory platform' },
    },
    alternatives: [
      { rank: 2, match_score: 40, skill: { slug: 'obra-superpowers', name: 'Superpowers' } },
    ],
    meta: { total_skills_searched: 833 },
    policy_decision: { status: 'human_review_required', summary: 'Review the audit page.' },
  };

  // ── SkillMD.ai fixture：字段来自 curl 实测 ──
  const SKILLMD_CATALOG = [
    {
      id: 'uuid-1',
      name: 'frontend-design',
      namespace: '@anthropics/claude-code/frontend-design',
      sourceUrl: 'https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design',
      description: 'Create distinctive, production-grade frontend interfaces.',
      version: null,
      author: 'anthropics',
      stars: 52420,
      installs: 23212,
      metadata: {
        repoOwner: 'anthropics',
        repoName: 'claude-code',
        directoryPath: 'plugins/frontend-design/skills/frontend-design',
        rawFileUrl:
          'https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/frontend-design/skills/frontend-design/SKILL.md',
      },
      createdAt: '2025-11-12T06:50:42.000Z',
      updatedAt: '2026-01-11T16:51:45.000Z',
    },
    {
      id: 'uuid-2',
      name: 'pdf',
      namespace: '@anthropics/skills/pdf',
      sourceUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
      description: 'Comprehensive PDF manipulation toolkit.',
      version: null,
      author: 'anthropics',
      stars: 24665,
      installs: 5130,
      metadata: {
        repoOwner: 'anthropics',
        repoName: 'skills',
        rawFileUrl: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md',
      },
      createdAt: '2025-11-04T07:05:04.729Z',
      updatedAt: '2026-01-11T16:51:45Z',
    },
    {
      // 只在按完整 namespace 精确搜索时出现 —— 模拟"存在但不在首页"的技能，
      // 用来单独覆盖"缓存未命中 → 回查上游"这条分支。
      id: 'uuid-3',
      name: 'lint-fix',
      namespace: '@acme/tools/lint-fix',
      sourceUrl: 'https://github.com/acme/tools/tree/main/skills/lint-fix',
      description: 'Fix lint errors.',
      version: null,
      author: 'acme',
      stars: 10,
      installs: 3,
      metadata: { repoOwner: 'acme', repoName: 'tools', rawFileUrl: null },
      createdAt: '2025-12-01T00:00:00.000Z',
      updatedAt: '2025-12-01T00:00:00.000Z',
      beyondFirstPage: true,
    },
  ];

  const SKILLMD_BODY = '---\nname: frontend-design\n---\n\nDesign distinctive interfaces.';

  const OAS_INSTALL_TEXT = 'OpenAgentSkill Install Handoff\nSkill: Crawl4AI\nRecommended command: npx skills add unclecode/crawl4ai';

  globalThis.fetch = async (u, init) => {
    const url = String(u);

    if (url.startsWith('https://www.openagentskill.com')) {
      upstreamCalls.push(url);
      if (upstreamMode === 'fail') {
        return new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } });
      }
      if (/\/resolve/.test(url)) {
        return new Response(JSON.stringify(OAS_RESOLVE), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (/\/api\/skills\/[^/]+\/install/.test(url)) {
        return new Response(OAS_INSTALL_TEXT, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (/\/api\/agent\/skills\/[^/]+$/.test(url)) {
        const slug = decodeURIComponent(url.split('/api/agent/skills/')[1].split('?')[0]);
        const one = OAS_CATALOG.skills.find((x) => x.slug === slug);
        if (!one) {
          return new Response('{"error":"Skill not found"}', {
            status: 404, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(one), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      // 目录 / 搜索：category= 是服务端过滤，这里如实模拟
      const cat = new URL(url).searchParams.get('category');
      const items = cat ? OAS_CATALOG.skills.filter((x) => x.category === cat) : OAS_CATALOG.skills;
      return new Response(JSON.stringify({ ...OAS_CATALOG, total: items.length, skills: items }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    // ── SkillMD.ai（claude-plugins.dev）───────────────────────────
    if (url.startsWith('https://claude-plugins.dev')) {
      upstreamCalls.push(url);
      if (upstreamMode === 'fail') {
        return new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } });
      }
      const u = new URL(url);
      const q = u.searchParams.get('q') || '';
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || 20);
      // 有 q 就是检索：覆盖全部（含不在首页的那条）。
      // 无 q 是目录首页：只给非 beyondFirstPage 的条目 —— 与真实上游一致。
      let pool;
      if (!q) {
        pool = SKILLMD_CATALOG.filter((x) => !x.beyondFirstPage);
      } else if (q.includes('@')) {
        // 完整 namespace 精确反查（详情就是靠这个）
        pool = SKILLMD_CATALOG.filter((x) => x.namespace === q);
      } else {
        const needle = q.toLowerCase();
        pool = SKILLMD_CATALOG.filter((x) =>
          `${x.name} ${x.description}`.toLowerCase().includes(needle),
        );
      }
      const page = pool.slice(offset, offset + limit);
      return new Response(
        JSON.stringify({ skills: page, total: pool.length, limit, offset }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // GitHub raw：**故意失败**，用来验证镜像回退分支真的被走到。
    if (url.startsWith('https://raw.githubusercontent.com')) {
      upstreamCalls.push(url);
      return new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } });
    }
    if (url.startsWith('https://cdn.jsdelivr.net/gh/')) {
      upstreamCalls.push(url);
      return new Response(SKILLMD_BODY, {
        status: 200, headers: { 'content-type': 'text/plain' },
      });
    }

    if (!url.startsWith('https://api.skillhub.cn')) return realFetch(u, init);
    upstreamCalls.push(url);
    if (upstreamMode === 'fail') {
      return new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
    if (/\/api\/skills(\?|$)/.test(url)) {
      // 真实上游的分页行为，mock 必须如实照做 —— 否则「参数名写错」这类 bug
      // 会静默通过。实测结论（见 skillhub.js 文件头）：
      //   - `page`（1-based）是**唯一**生效的翻页参数
      //   - `offset` / `cursor` / `skip` / … 全部被忽略，换任何值都返回同一批
      //   - `limit` 被忽略，每页固定 20 条
      //   - `category` 是服务端过滤
      // 之前这个分支无视一切分页参数、直接返回全量，恰好和适配器里写错的
      // offset 游标互相"自洽"：上游明明不翻页、代码却认为翻页成功了。
      const u2 = new URL(url);
      const cat = u2.searchParams.get('category');
      const pageNo = Math.max(1, Number(u2.searchParams.get('page') || '1') || 1);
      const all = UPSTREAM_LIST.data.skills;
      const pool = cat ? all.filter((x) => x.category === cat) : all;
      // 上游每页固定 20，分片只能按它切；total 沿用「未过滤时的 149522」，
      // 这样"total 透传"和"末页判定用 total"两条都能被测到。
      const slice = pool.slice((pageNo - 1) * UPSTREAM_PAGE_SIZE, pageNo * UPSTREAM_PAGE_SIZE);
      return new Response(
        JSON.stringify({
          ...UPSTREAM_LIST,
          data: {
            ...UPSTREAM_LIST.data,
            skills: slice,
            total: cat ? pool.length : UPSTREAM_LIST.data.total,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (/\/api\/v1\/skills\//.test(url)) {
      const slug = decodeURIComponent(url.split('/api/v1/skills/')[1].split('?')[0]);
      const detail = UPSTREAM_DETAIL[slug];
      if (!detail) {
        return new Response('{"detail":"not found"}', {
          status: 404, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(detail), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };

  let installedSkillId;

  await test('GET /hub/skill 返回全部注册来源（含能力开关与地域标注）', async () => {
    const r = await realFetch(base + '/hub/skill');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(
      d.map((h) => h.hub_id).sort(),
      ['openagentskill.com', 'skillhub.cn', 'skillmd.ai'],
      '三个公共来源都应注册',
    );
    const sh = d.find((h) => h.hub_id === 'skillhub.cn');
    const oas = d.find((h) => h.hub_id === 'openagentskill.com');
    const md = d.find((h) => h.hub_id === 'skillmd.ai');

    // 显示名带地域标注，避免侧栏出现两个无法区分的 "S"
    assert.equal(sh.display_name, 'SkillHub.cn（中国）');
    assert.equal(oas.display_name, 'OpenAgentSkill.com（海外）');
    assert.equal(md.display_name, 'SkillMD.ai（海外）');

    assert.equal(sh.supports_categories, true);
    assert.equal(sh.supports_resolve, false, 'SkillHub 没有任务匹配端点');
    assert.equal(oas.supports_resolve, true, 'OpenAgentSkill 独有任务匹配');
    // 能力由适配器有没有实现该函数推导，不是手写元信息。
    // SkillMD.ai 有分类 —— 但那是**关键词代理分类**（上游没有原生分类字段，
    // 见 skillmd.js 的 CATEGORIES 注释），不是上游给的。
    assert.equal(md.supports_categories, true);
    assert.equal(md.supports_resolve, false);
  });

  await test('GET /hub/skill/:hub/cards 代理上游并 normalize 字段', async () => {
    const before = upstreamCalls.length;
    const r = await realFetch(base + '/hub/skill/skillhub.cn/cards?q=pdf');
    const d = await r.json();
    assert.equal(r.status, 200);
    // 桩给的是 3 行（含一条同 slug 的孪生条目），normalize 后应按 id 去掉 1 条
    assert.equal(d.cards.length, 2);
    assert.equal(d.total, 149522);
    // page-based cursor：上游每页 20 条，149522 条远没翻完 → 下一页就是 page=2。
    // 注意这是**页码**而不是 offset —— 上游只认 page，写成 offset 会永远返回同一批。
    assert.equal(d.next_cursor, '2');

    const called = upstreamCalls.slice(before).join(' ');
    assert.ok(called.includes('page=1'), '分页参数必须是 page（上游只认它）');
    assert.ok(!called.includes('offset='), '上下游会忽略 offset —— 再发它就是把忽略当接受');

    const c = d.cards[0];
    assert.equal(c.id, 'pdf-reader');
    assert.equal(c.name, 'PDF Reader');
    assert.equal(c.display_name, 'PDF Reader', 'list 无 displayName 时回退 name');
    assert.equal(c.version, '1.2.0');
    // author 来自 list 的扁平 ownerName —— 早先只看 owner.displayName，导致恒为 null
    assert.equal(c.author, 'jason');
    assert.equal(c.installs, 75956);
    assert.equal(c.downloads, 949690);
    assert.equal(c.metadata.stars, 1747);
    assert.equal(c.updated_at, 1789227234, '毫秒 epoch → 秒');
    assert.equal(c.markdown, null, 'list 阶段不带 markdown（体积）');
    assert.equal(c.description_zh, '读取和解析 PDF 文档');
    // tags 来自 subCategories[].name + category
    assert.deepEqual(c.tags, ['文档处理', 'document']);

    // 第二条：list 带 displayName 时优先用它
    assert.equal(d.cards[1].name, 'code-review93');
    assert.equal(d.cards[1].display_name, 'Code Review');
    assert.equal(d.cards[1].description_zh, '自动审查代码改动');

    // keyword 透传到上游
    assert.ok(upstreamCalls.some((u) => u.includes('keyword=pdf')), '应把 keyword 转发给上游');
  });

  await test('SkillHub 按 page 翻页：拿到的是另一批，且页内同 slug 去重', async () => {
    // 桩里只有 3 行，所以 page=1 就把它们全给了、page=2 是空页 —— 但"page 变了
    // 结果才变"这件事必须成立，否则前端会无限追加同一页（技能市场重复的根源）。
    const p1 = await (await realFetch(base + '/hub/skill/skillhub.cn/cards')).json();
    assert.equal(p1.cards.length, 2, '同 slug 孪生条目应被去掉');
    assert.equal(p1.next_cursor, '2', '149522 条没翻完，应给出下一页');

    const before = upstreamCalls.length;
    const p2 = await (await realFetch(base + `/hub/skill/skillhub.cn/cards?cursor=${p1.next_cursor}`)).json();
    assert.equal(p2.cards.length, 0, '桩里第二页是空页（模拟真实上游越界返空数组）');
    assert.equal(p2.next_cursor, null, '空页 = 没有下一页，游标必须断掉');

    const called = upstreamCalls.slice(before).join(' ');
    assert.ok(called.includes('page=2'), 'cursor 应被解析成页码 2');
    assert.ok(!called.includes('offset='), '不得回退成 offset');
  });

  await test('GET /hub/skill/:hub/cards/:id 详情带 markdown（overviewMd）', async () => {
    const r = await realFetch(base + '/hub/skill/skillhub.cn/cards/pdf-reader');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.id, 'pdf-reader');
    assert.equal(d.name, 'pdf-reader', 'detail 无 name 字段 → 回退 slug');
    assert.equal(d.display_name, 'PDF 阅读器');
    assert.equal(d.markdown, '# PDF Reader\n\n用 `pdftotext` 抽取正文。');
    assert.equal(d.version, '1.3.15', 'detail 的 latestVersion 覆盖 list 的 version');
    // 上下两个端点字段名/类型都不一样，这里覆盖类型转换：
    assert.equal(d.installs, 56, "stats.installs 是字符串 '56'，要转成数字");
    assert.equal(d.downloads, 1101);
    assert.equal(d.updated_at, 1789227210, '毫秒字符串 epoch → 秒');
    assert.equal(d.author, '杨科', 'detail 拿 owner.displayName');
    assert.equal(d.description, 'Read and parse PDF documents', 'detail 用 summary');
    assert.equal(d.description_zh, '读取和解析 PDF 文档', 'detail 用 summary_zh');
  });

  await test('未知 slug 详情 → 透传上游 404', async () => {
    const r = await realFetch(base + '/hub/skill/skillhub.cn/cards/no-such-skill');
    assert.equal(r.status, 404);
  });

  await test('POST /hub/skill/:hub/cards/:id/install 落到本地技能库', async () => {
    const r = await realFetch(base + '/hub/skill/skillhub.cn/cards/pdf-reader/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.ok(d.id, 'install 应分配本地 id');
    // 未传 name 时用卡片名；detail 端点没有 name，normalize 回退 slug
    assert.equal(d.name, 'pdf-reader');
    assert.equal(d.card_id, 'pdf-reader');
    assert.equal(d.display_name, 'PDF 阅读器', '人类可读名走 display_name');
    assert.equal(d.display_name, 'PDF 阅读器');
    assert.equal(d.hub_id, 'skillhub.cn');
    assert.equal(d.card_id, 'pdf-reader');
    assert.equal(d.enabled, true);
    assert.equal(d.markdown, '# PDF Reader\n\n用 `pdftotext` 抽取正文。');
    assert.equal(d.description_zh, '读取和解析 PDF 文档', 'install 快照中文描述');
    assert.equal(d.installs, undefined, 'install 不落盘统计数字');
    installedSkillId = d.id;
  });

  await test('重复 install 同一卡片 → 幂等返回已有记录（不新建）', async () => {
    const r = await realFetch(base + '/hub/skill/skillhub.cn/cards/pdf-reader/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.id, installedSkillId, '同一 card 不应重复安装');
  });

  await test('GET /skill 列表（SkillView，不含 markdown）', async () => {
    const r = await realFetch(base + '/skill', { headers: { accept: 'application/json' } });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(d), 'GET /skill 应返回数组');
    assert.equal(d.length, 1);
    assert.equal(d[0].id, installedSkillId);
    assert.equal(d[0].card_id, 'pdf-reader');
    assert.ok(!('markdown' in d[0]), '列表接口不应带 markdown（体积）');
  });

  await test('GET /skill/:id 详情 + /skill/:id/markdown', async () => {
    const r = await realFetch(base + `/skill/${installedSkillId}`);
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.id, installedSkillId);
    assert.ok(d.markdown.includes('PDF Reader'));

    const r2 = await realFetch(base + `/skill/${installedSkillId}/markdown`);
    assert.equal(r2.status, 200);
    const md = await r2.text();
    assert.ok(md.includes('pdftotext'), 'markdown 端点应返回 SKILL.md 正文');
  });

  await test('install 名字冲突 → 409 NAME_CONFLICT', async () => {
    const r = await realFetch(base + '/hub/skill/skillhub.cn/cards/code-review93/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'pdf-reader' }), // 与已装的同名
    });
    const d = await r.json();
    assert.equal(r.status, 409);
    assert.ok(d.detail.includes('同名'), '应返回中文冲突提示');
    assert.equal(d.existing.id, installedSkillId);
  });

  await test('install 自定义 name → 用自定义名落库', async () => {
    const r = await realFetch(base + '/hub/skill/skillhub.cn/cards/code-review93/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-review' }),
    });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.name, 'my-review');
    assert.equal(d.card_id, 'code-review93');
    assert.notEqual(d.id, installedSkillId);
    // list 现在应该有 2 条
    const r2 = await realFetch(base + '/skill', { headers: { accept: 'application/json' } });
    assert.equal((await r2.json()).length, 2);
    // 清理，让后续删除断言更清晰
    await realFetch(base + `/skill/${d.id}`, { method: 'DELETE' });
  });

  await test('上游 5xx → 502 且返回空 cards（前端不会崩）', async () => {
    upstreamMode = 'fail';
    try {
      const r = await realFetch(base + '/hub/skill/skillhub.cn/cards');
      const d = await r.json();
      assert.equal(r.status, 502);
      assert.deepEqual(d.cards, []);
      assert.equal(d.next_cursor, null);
      assert.ok(d.detail, '应带 detail 说明上游失败');
    } finally {
      upstreamMode = 'ok';
    }
  });

  await test('DELETE /skill/:id 删除，列表回到空', async () => {
    const r = await realFetch(base + `/skill/${installedSkillId}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    const r2 = await realFetch(base + '/skill', { headers: { accept: 'application/json' } });
    assert.deepEqual(await r2.json(), []);

    const r3 = await realFetch(base + `/skill/${installedSkillId}`);
    assert.equal(r3.status, 404);
  });

  // ─────────────────────────────────────────────────────────────
  // 分类清单 / 分类过滤 / 多源分发 / OpenAgentSkill 任务匹配
  // ─────────────────────────────────────────────────────────────

  await test('GET /hub/skill/:hub/categories —— SkillHub 是固定 9 类', async () => {
    const r = await realFetch(base + '/hub/skill/skillhub.cn/categories');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.length, 9, '实测的顶层分类就是 9 个');
    assert.ok(d.every((c) => c.approximate === false), '固定枚举不是"聚合出来的"');
    assert.ok(d.some((c) => c.id === 'office-efficiency'));
  });

  await test('GET /hub/skill/:hub/categories —— OpenAgentSkill 从目录聚合', async () => {
    const r = await realFetch(base + '/hub/skill/openagentskill.com/categories');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(d.map((c) => c.id).sort(), ['design-creative', 'web-automation']);
    assert.ok(d.every((c) => c.approximate === true), '聚合出来的分类要标记 approximate');
  });

  await test('category 透传到上游且真的过滤（SkillHub 服务端过滤）', async () => {
    const before = upstreamCalls.length;
    const r = await realFetch(base + '/hub/skill/skillhub.cn/cards?category=dev');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.cards.length, 1, '只应剩 dev 分类下的那一条');
    assert.equal(d.cards[0].id, 'code-review93');
    // metadata.category 单独暴露 —— tags 只留 8 个，末位会被截断，不能依赖它
    assert.equal(d.cards[0].metadata.category, 'dev');
    const called = upstreamCalls.slice(before).join(' ');
    assert.ok(called.includes('category=dev'), 'category 必须转发给上游（否则只是前端假过滤）');
  });

  await test('OpenAgentSkill 目录 normalize（与 SkillHub 形状不同）', async () => {
    const r = await realFetch(base + '/hub/skill/openagentskill.com/cards');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.cards.length, 2);
    assert.equal(d.next_cursor, null, '这个源没有分页，不应给出 cursor');

    const c = d.cards.find((x) => x.id === 'anthropic-frontend-design');
    assert.equal(c.hub_id, 'openagentskill.com');
    assert.equal(c.name, 'anthropic-frontend-design', 'name 当 handle（slug）');
    assert.equal(c.display_name, 'Frontend Design', '展示名在 display_name');
    assert.equal(c.author, 'anthropics');
    assert.equal(c.version, null, "仓库版本 'Unknown' 不该当版本号展示");
    assert.equal(c.installs, 31);
    assert.equal(c.description_zh, null, '这个源没有中文描述');
    assert.equal(c.metadata.score, 100);
    assert.equal(c.metadata.stars, 175874);
    assert.equal(c.metadata.category, 'design-creative');
    assert.equal(c.metadata.install_command, 'npx skills add anthropics/skills --skill frontend-design');
    assert.ok(c.tags.includes('design-creative'), '分类也要参与关键字过滤');
    // 正文是合成的（上游没有 SKILL.md 可拿）：长描述 + 事实清单
    assert.ok(c.markdown.includes('long-form paragraph'));
    assert.ok(c.markdown.includes('Category: design-creative'));
    assert.ok(c.markdown.includes('Install:'));
  });

  await test('OpenAgentSkill category 过滤', async () => {
    const r = await realFetch(base + '/hub/skill/openagentskill.com/cards?category=web-automation');
    const d = await r.json();
    assert.equal(d.cards.length, 1);
    assert.equal(d.cards[0].id, 'crawl4ai');
  });

  await test('OpenAgentSkill 详情', async () => {
    const r = await realFetch(base + '/hub/skill/openagentskill.com/cards/crawl4ai');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.display_name, 'Crawl4AI');
    // 这个源的 version 是仓库版本（几乎全是 1.0.0），展示无意义 —— 一律置空
    assert.equal(d.version, null);
    assert.equal(d.metadata.category, 'web-automation');
  });

  await test('OpenAgentSkill resolve（按任务匹配）', async () => {
    const r = await realFetch(base + '/hub/skill/openagentskill.com/resolve?task=抓取网页内容&agent=codex');
    const d = await r.json();
    assert.equal(r.status, 200);
    // 上游把技能字段嵌在 selected.skill 里 —— 直接读 selected.slug 会拿到空
    assert.equal(d.selected.id, 'topoteretes-cognee');
    assert.equal(d.selected.display_name, 'Cognee');
    assert.equal(d.selected.match_score, 52);
    assert.deepEqual(d.alternatives.map((a) => a.id), ['obra-superpowers']);
    assert.equal(d.install_command, 'npx skills add topoteretes/cognee');
    assert.equal(d.total_searched, 833);
    assert.equal(d.policy, 'human_review_required');
  });

  await test('resolve 缺 task → 422；不支持该能力的源 → 404', async () => {
    const bad = await realFetch(base + '/hub/skill/openagentskill.com/resolve');
    assert.equal(bad.status, 422);
    const unsupported = await realFetch(base + '/hub/skill/skillhub.cn/resolve?task=x');
    assert.equal(unsupported.status, 404, 'SkillHub 没有 resolve，应明确 404 而不是空结果');
  });

  await test('未知 hubId → 404（不再静默兜底到某个源）', async () => {
    const r = await realFetch(base + '/hub/skill/nope.com/cards');
    assert.equal(r.status, 404);
  });

  // ─────────────────────────────────────────────────────────────
  // SkillMD.ai（claude-plugins.dev）—— 真分页 + 真实 SKILL.md 正文
  // ─────────────────────────────────────────────────────────────

  await test('SkillMD.ai 列表 normalize + 真实分页', async () => {
    const r = await realFetch(base + '/hub/skill/skillmd.ai/cards?limit=1');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.cards.length, 1);
    assert.equal(d.total, 2, 'total 是上游真实总量，不是返回条数');
    // 真分页：cursor 是下一个 offset
    assert.equal(d.next_cursor, '1');

    const c = d.cards[0];
    // namespace 是这里唯一全局唯一的标识（47k 条里 name 会撞），所以同时当 id 和 handle
    assert.equal(c.id, '@anthropics/claude-code/frontend-design');
    assert.equal(c.name, '@anthropics/claude-code/frontend-design');
    assert.equal(c.display_name, 'frontend-design', '展示名用短名，作者另显示');
    assert.equal(c.author, 'anthropics');
    assert.equal(c.installs, 23212);
    assert.equal(c.version, null);
    assert.equal(c.description_zh, null);
    assert.deepEqual(c.tags, ['anthropics/claude-code'], '仓库作为标签，方便按来源筛');
    assert.equal(c.updated_at, 1768150305, 'ISO 串 → epoch 秒');
    assert.equal(c.metadata.stars, 52420);
    assert.equal(c.metadata.category, null, '上游没有分类字段');
    assert.ok(c.metadata.raw_file_url.endsWith('/SKILL.md'));
    assert.equal(c.markdown, null, '列表不带正文（20 条 SKILL.md 就是几百 KB）');
  });

  await test('SkillMD.ai offset 分页真的翻页', async () => {
    const p1 = await (await realFetch(base + '/hub/skill/skillmd.ai/cards?limit=1')).json();
    const p2 = await (
      await realFetch(base + `/hub/skill/skillmd.ai/cards?limit=1&cursor=${p1.next_cursor}`)
    ).json();
    assert.equal(p2.cards[0].id, '@anthropics/skills/pdf', '第二页应是另一条');
    assert.notEqual(p2.cards[0].id, p1.cards[0].id);
    assert.equal(p2.next_cursor, null, '两条取完就没有下一页');
  });

  await test('SkillMD.ai 详情：raw 不通时回退 jsDelivr 镜像拿到 SKILL.md', async () => {
    // 列表先跑一遍填充缓存，然后清掉 raw/镜像的调用记录，只看详情那一次
    await realFetch(base + '/hub/skill/skillmd.ai/cards?limit=2');
    const before = upstreamCalls.length;
    // 直接把 raw 地址当 cardId 会走"缓存命中"分支（不查上游），这正是我们要的
    const id = encodeURIComponent('@anthropics/skills/pdf');
    const r = await realFetch(base + `/hub/skill/skillmd.ai/cards/${id}`);
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.display_name, 'pdf');
    assert.equal(
      d.markdown,
      SKILLMD_BODY,
      'raw 403 后必须回退镜像；这条断言覆盖的就是回退分支',
    );
    const called = upstreamCalls.slice(before);
    assert.ok(called.some((u) => u.includes('raw.githubusercontent.com')), '先试原始地址');
    assert.ok(
      called.some((u) => u.startsWith('https://cdn.jsdelivr.net/gh/anthropics/skills@main/')),
      '原始地址失败后必须改走 jsDelivr 镜像（branch 从原地址里取）',
    );
  });

  await test('SkillMD.ai 缓存：列表拿过的卡片详情不再打上游', async () => {
    await realFetch(base + '/hub/skill/skillmd.ai/cards?limit=2');
    const before = upstreamCalls.length;
    // 用缓存里的第一条
    const id = encodeURIComponent('@anthropics/claude-code/frontend-design');
    const r = await realFetch(base + `/hub/skill/skillmd.ai/cards/${id}`);
    assert.equal(r.status, 200);
    const called = upstreamCalls.slice(before);
    // 只允许 raw / 镜像这类正文请求，不允许再查 claude-plugins.dev
    assert.ok(
      !called.some((u) => u.startsWith('https://claude-plugins.dev')),
      '卡片元数据应命中进程内缓存，不该回查上游',
    );
  });

  await test('SkillMD.ai 详情：缓存未命中时用完整 namespace 回查上游', async () => {
    // 这条 fixture 不在目录首页，所以缓存里一定没有 —— 走的才是回查分支
    const id = encodeURIComponent('@acme/tools/lint-fix');
    const before = upstreamCalls.length;
    const r = await realFetch(base + `/hub/skill/skillmd.ai/cards/${id}`);
    assert.equal(r.status, 200);
    const d = await r.json(); // 只能读一次
    assert.equal(d.id, '@acme/tools/lint-fix');
    const called = upstreamCalls.slice(before);
    assert.ok(
      called.some((u) => u.startsWith('https://claude-plugins.dev')),
      '缓存未命中时应回查上游',
    );
    assert.ok(
      called.some((u) => decodeURIComponent(u).includes('@acme/tools/lint-fix')),
      '回查要用完整 namespace 当 q（实测命中很准）',
    );
    // rawFileUrl 为 null → 不该去拉正文
    assert.equal(d.markdown, null, '没有 raw 地址时正文为 null，不报错');
  });

  await test('SkillMD.ai 未知 namespace → 404', async () => {
    const id = encodeURIComponent('@nobody/nothing/nope');
    const r = await realFetch(base + `/hub/skill/skillmd.ai/cards/${id}`);
    assert.equal(r.status, 404);
  });

  await test('SkillMD.ai 分类：11 个关键词代理分类 + 真实计数', async () => {
    const before = upstreamCalls.length;
    const r = await realFetch(base + '/hub/skill/skillmd.ai/categories');
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.length, 11, '分类清单长度固定');
    assert.ok(d.some((c) => c.id === 'security'));
    assert.ok(d.some((c) => c.id === 'document-processing'));
    // count 是"代理关键词在上游的真实匹配总数"，approximate 标记它是关键词代理
    assert.ok(d.every((c) => c.approximate === true), '关键词代理分类必须标 approximate');
    assert.ok(d.every((c) => c.count !== null), '每个分类都应有真实计数');
    // 计数靠并发 limit=1 探测：11 个分类 → 至少 11 次上游请求
    const probes = upstreamCalls.slice(before).filter((u) => u.startsWith('https://claude-plugins.dev'));
    assert.ok(probes.length >= 11, `应逐分类探测计数，实际 ${probes.length} 次`);
    assert.ok(probes.every((u) => u.includes('limit=1')), '探测只取 1 条，只要 total');
  });

  await test('SkillMD.ai 分类计数有缓存（第二次不再探测）', async () => {
    const before = upstreamCalls.length;
    const r = await realFetch(base + '/hub/skill/skillmd.ai/categories');
    assert.equal((await r.json()).length, 11);
    const probes = upstreamCalls.slice(before).filter((u) => u.startsWith('https://claude-plugins.dev'));
    assert.equal(probes.length, 0, '命中计数缓存时不该再打上游');
  });

  await test('SkillMD.ai 分类会把代理关键词当检索词发给上游', async () => {
    const before = upstreamCalls.length;
    const r = await realFetch(base + '/hub/skill/skillmd.ai/cards?category=security');
    assert.equal(r.status, 200);
    const called = upstreamCalls.slice(before).filter((u) => u.startsWith('https://claude-plugins.dev'));
    assert.equal(called.length, 1);
    assert.ok(
      decodeURIComponent(called[0]).includes('q=security'),
      'security 分类应转成 q=security 发给上游（该源不支持服务端分类过滤）',
    );
  });

  await test('SkillMD.ai 显式搜索词优先于分类', async () => {
    const before = upstreamCalls.length;
    await realFetch(base + '/hub/skill/skillmd.ai/cards?category=security&q=pdf');
    const called = upstreamCalls.slice(before).filter((u) => u.startsWith('https://claude-plugins.dev'));
    assert.equal(called.length, 1);
    const u = decodeURIComponent(called[0]);
    assert.ok(u.includes('q=pdf'), '用户输入应覆盖分类的代理关键词');
    assert.ok(!u.includes('q=security'), '不应把分类关键词也拼进去');
  });

  await test('SkillMD.ai 未知分类 id 退化成"热门目录"而不是报错', async () => {
    const r = await realFetch(base + '/hub/skill/skillmd.ai/cards?category=nope');
    assert.equal(r.status, 200);
    assert.ok((await r.json()).cards.length > 0, '未知分类不该 500，退化成无关键词目录');
  });

  await test('SkillMD.ai install：真实正文随卡落库', async () => {
    const id = encodeURIComponent('@anthropics/skills/pdf');
    const r = await realFetch(base + `/hub/skill/skillmd.ai/cards/${id}/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.hub_id, 'skillmd.ai');
    assert.equal(d.name, '@anthropics/skills/pdf');
    assert.equal(d.display_name, 'pdf');
    assert.equal(d.author, 'anthropics');
    assert.equal(d.markdown, SKILLMD_BODY, '这是唯一能拿到真实 SKILL.md 正文的源');

    await realFetch(base + `/skill/${d.id}`, { method: 'DELETE' });
    const after = await realFetch(base + '/skill', { headers: { accept: 'application/json' } });
    assert.deepEqual(await after.json(), []);
  });

  await test('OpenAgentSkill install：正文并入安装交接单', async () => {
    const r = await realFetch(base + '/hub/skill/openagentskill.com/cards/crawl4ai/install', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.name, 'crawl4ai');
    assert.equal(d.display_name, 'Crawl4AI');
    assert.equal(d.hub_id, 'openagentskill.com');
    assert.ok(d.markdown.includes('Crawls sites into markdown'), '合成正文在');
    assert.ok(
      d.markdown.includes('OpenAgentSkill Install Handoff'),
      '上游的安装交接单应并进正文，让模型知道实际怎么装',
    );

    // 两个源各装一个，列表里应能区分
    const list = await realFetch(base + '/skill', { headers: { accept: 'application/json' } });
    const skills = await list.json();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].hub_id, 'openagentskill.com');

    await realFetch(base + `/skill/${d.id}`, { method: 'DELETE' });
    const after = await realFetch(base + '/skill', { headers: { accept: 'application/json' } });
    assert.deepEqual(await after.json(), [], '清理干净，不影响后续断言');
  });


  globalThis.fetch = realFetch;
  upstreamCalls.length = 0;

  // ─────────────────────────────────────────────────────────────
  // CoCode 新增：权限 HITL / 允许清单 / 检查点 / 会话检索 / git 状态
  // ─────────────────────────────────────────────────────────────
  console.log('--- 权限 HITL（真 ASK 流程）---');

  /** 订阅 SSE 并后台累积事件，返回 { events, stop, waitFor } */
  async function listen(sid) {
    const ac = new AbortController();
    const res = await realFetch(base + `/sessions/${sid}/stream?agent_id=${agentId}`, { signal: ac.signal });
    const events = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
            }
          }
        }
      } catch { /* aborted */ }
    })();
    return {
      events,
      stop: () => ac.abort(),
      async waitFor(pred, ms = 4000) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (pred(events)) return true;
          await new Promise((r) => setTimeout(r, 25));
        }
        return false;
      }
    };
  }

  await test('HITL：default 模式下写入工具挂起 → 用户确认 → 执行并落盘', async () => {
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const hitlDir = join(tmpdir(), `vega-asapi-hitl-${sid}`);
    mkdirSync(hitlDir, { recursive: true });
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      // 默认就是 default，这里显式写一遍，把语义钉死
      body: JSON.stringify({ cwd: hitlDir, permission_mode: 'default' })
    });

    let round = 0;
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路
      round++;
      if (round === 1) {
        return sse([{ tool_calls: [{ index: 0, id: 'w1', function: { name: 'Write', arguments: JSON.stringify({ path: 'approved.txt', content: 'approved' }) } }] }]);
      }
      return sse([{ content: '已写入 approved.txt' }]);
    };

    const sub = await listen(sid);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '写个文件' }] } })
      });

      // 1) 出现权限询问
      const got = await sub.waitFor((ev) => ev.some((e) => e.type === 'REQUIRE_USER_CONFIRM'));
      assert.ok(got, '应收到 REQUIRE_USER_CONFIRM; got: ' + sub.events.map((e) => e.type).join(','));
      const req = sub.events.find((e) => e.type === 'REQUIRE_USER_CONFIRM');
      const tc = req.tool_calls[0];
      assert.equal(tc.name, 'Write');
      assert.equal(tc.state, 'asking');
      assert.ok(Array.isArray(tc.suggested_rules) && tc.suggested_rules.length > 0, 'confirm 卡片需要 suggested_rules');
      assert.equal(tc.suggested_rules[0].tool_name, 'Write');
      assert.equal(tc.suggested_rules[0].behavior, 'allow');
      // 此时还没写盘（挂起中）
      assert.ok(!existsSync(join(hitlDir, 'approved.txt')), '未确认前不应落盘');

      const replyId = sub.events.find((e) => e.type === 'REPLY_START').reply_id;

      // 2) 用户确认（并勾选"以后都允许"）
      const rule = { tool_name: 'Write', rule_content: '**', behavior: 'allow', source: 'userSettings' };
      const confirmRes = await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId, session_id: sid,
          input: {
            type: 'USER_CONFIRM_RESULT', id: 'c1', created_at: new Date().toISOString(),
            reply_id: replyId,
            confirm_results: [{ confirmed: true, tool_call: { id: 'w1', name: 'Write', input: '{}', state: 'asking', created_at: new Date().toISOString() }, rules: [rule] }]
          }
        })
      });
      const confirmBody = await confirmRes.json();
      assert.equal(confirmBody.status, 'ok');
      assert.equal(confirmBody.resolved, 1, '应有一个挂起请求被唤醒');

      // 3) 运行继续 → 工具真的执行 → 结束
      const finished = await sub.waitFor((ev) => ev.some((e) => e.type === 'REPLY_END'));
      assert.ok(finished, '确认后应跑到 REPLY_END');
      const trEnd = sub.events.find((e) => e.type === 'TOOL_RESULT_END');
      assert.equal(trEnd.state, 'success');
      assert.match(readFileSync(join(hitlDir, 'approved.txt'), 'utf8'), /approved/);

      // 4) "以后都允许"的规则落盘了
      const rules = await (await realFetch(base + '/permission/rules')).json();
      assert.ok(rules.rules.some((r) => r.tool_name === 'Write' && r.behavior === 'allow'), '规则应持久化到配置');

      // 5) 落盘 display 里已答复的卡片必须翻牌（否则刷新/重启后"已答复"
      //    卡片复活成可点状态，再作答就撞"没有等待中的确认请求"）
      const sess = await (await realFetch(base + `/sessions/${sid}/messages`)).json();
      const asks = (sess.messages ?? []).flatMap((m) => m.content ?? [])
        .filter((b) => b.type === 'tool_call');
      assert.ok(asks.length > 0, 'display 应包含 tool_call 块');
      for (const b of asks) assert.notEqual(b.state, 'asking', `tool_call ${b.id} 不应停留在 asking`);
    } finally {
      sub.stop();
      globalThis.fetch = realFetch;
    }
  });

  await test('HITL：用户拒绝时不执行，且把拒绝反馈给模型', async () => {
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const dir = join(tmpdir(), `vega-asapi-hitl-deny-${sid}`);
    mkdirSync(dir, { recursive: true });
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, permission_mode: 'default' })
    });

    let round = 0;
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路
      round++;
      if (round === 1) {
        return sse([{ tool_calls: [{ index: 0, id: 'x1', function: { name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf build' }) } }] }]);
      }
      return sse([{ content: '好的，我不删了' }]);
    };

    const sub = await listen(sid);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '清一下 build' }] } })
      });
      assert.ok(await sub.waitFor((ev) => ev.some((e) => e.type === 'REQUIRE_USER_CONFIRM')), '复合命令应触发询问');
      const replyId = sub.events.find((e) => e.type === 'REPLY_START').reply_id;

      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId, session_id: sid,
          input: {
            type: 'USER_CONFIRM_RESULT', id: 'c2', created_at: new Date().toISOString(), reply_id: replyId,
            confirm_results: [{ confirmed: false, tool_call: { id: 'x1', name: 'Bash', input: '{}', state: 'asking', created_at: new Date().toISOString() }, rules: null }]
          }
        })
      });
      assert.ok(await sub.waitFor((ev) => ev.some((e) => e.type === 'REPLY_END')), '拒绝后仍要收尾');

      const trEnd = sub.events.find((e) => e.type === 'TOOL_RESULT_END');
      assert.equal(trEnd.state, 'error');
      const trText = sub.events.filter((e) => e.type === 'TOOL_RESULT_TEXT_DELTA').map((e) => e.delta).join('');
      assert.match(trText, /用户拒绝|拒绝/, '拒绝结果要回灌给模型');
    } finally {
      sub.stop();
      globalThis.fetch = realFetch;
    }
  });

  await test('HITL：迟到的确认回复优雅降级（200 stale，卡片作废而非 409）', async () => {
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const r = await realFetch(base + '/chat/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId, session_id: sid,
        input: { type: 'USER_CONFIRM_RESULT', reply_id: 'nope', confirm_results: [{ confirmed: true, tool_call: { id: 'z' } }] }
      })
    });
    // 迟到的答复不算客户端错误：不再 409，而是 200 + stale 语义，
    // 同时把 display 里残留的 asking 卡片作废。
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.status, 'stale');
    assert.equal(d.not_running, true);
    assert.equal(d.stale, 1);
  });

  // ─────────────────────────────────────────────────────────────
  // H2：子代理 HITL —— worker 的确认经队长 bus 投影 / 答复 / 清卡
  // mock 编排：队长 3 轮（TeamCreate→AgentCreate(accept_edits)→AgentRun），
  // worker 2 轮（Bash ask→文本）。accept_edits 下 Bash 必问（只读自动
  // 放行只作用于 default 模式），天然触发 worker 的 permissionAsk。
  // ─────────────────────────────────────────────────────────────
  console.log('--- 子代理 HITL（worker 确认投影到队长视图）---');

  function makeTeamMock(workerCommand) {
    let leaderRound = 0, workerRound = 0;
    return async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]);
      const body = JSON.parse(init?.body || '{}');
      const msgs = body.messages || [];
      const isWorker = msgs.some((m) => typeof m.content === 'string' && m.content.includes('【队长 任务指派】'));
      if (isWorker) {
        workerRound++;
        if (workerRound === 1) {
          return sse([{ tool_calls: [{ index: 0, id: 'wt1', function: { name: 'Bash', arguments: JSON.stringify({ command: workerCommand }) } }] }]);
        }
        return sse([{ content: 'worker 完成' }]);
      }
      leaderRound++;
      if (leaderRound === 1) {
        return sse([{ tool_calls: [{ index: 0, id: 'lt1', function: { name: 'TeamCreate', arguments: JSON.stringify({ name: '测试小队' }) } }] }]);
      }
      if (leaderRound === 2) {
        return sse([{ tool_calls: [{ index: 0, id: 'lt2', function: { name: 'AgentCreate', arguments: JSON.stringify({ role: '研究员', goal: '执行命令', agentCreatePermissions: 'accept_edits' }) } }] }]);
      }
      if (leaderRound === 3) {
        const src = msgs.find((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('agent_id:'));
        const m2 = src && src.content.match(/agent_id:\s*([A-Za-z0-9_-]+)/);
        if (!m2) throw new Error('AgentCreate 返回值里没解析出 worker agent_id');
        return sse([{ tool_calls: [{ index: 0, id: 'lt3', function: { name: 'AgentRun', arguments: JSON.stringify({ agent_id: m2[1], task: '执行命令并汇报结果' }) } }] }]);
      }
      return sse([{ content: '团队任务完成' }]);
    };
  }

  async function makeTeamLeaderSession(tag) {
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const dir = join(tmpdir(), `vega-asapi-${tag}-${sid}`);
    mkdirSync(dir, { recursive: true });
    // 队长 bypass：team 工具全部直通；worker 权限由 AgentCreate 请求决定
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, permission_mode: 'bypass' })
    });
    return { sid, dir };
  }

  await test('子代理 HITL：worker 询问卡片投影队长 → 队长答复放行 → 清卡继续', async () => {
    const { sid, dir } = await makeTeamLeaderSession('subhitl');
    globalThis.fetch = makeTeamMock('touch worker-exec.txt');
    const sub = await listen(sid);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '组建团队执行命令' }] } })
      });

      // 1) team_updated：TeamCreate/AgentCreate 成功后各广播一次
      assert.ok(
        await sub.waitFor((ev) => ev.filter((e) => e.type === 'CUSTOM' && e.name === 'team_updated').length >= 2),
        '应收到 team_updated 广播; got: ' + sub.events.map((e) => e.name || e.type).join(',')
      );

      // 2) 子代理确认事件 + payload 契约（前端 SubagentHitlCard 依赖这些字段）
      assert.ok(
        await sub.waitFor((ev) => ev.some((e) => e.type === 'CUSTOM' && e.name === 'subagent_require_user_confirm')),
        '应收到 subagent_require_user_confirm'
      );
      const entry = sub.events.find((e) => e.type === 'CUSTOM' && e.name === 'subagent_require_user_confirm').value;
      assert.ok(entry.worker_session_id, 'entry 应带 worker_session_id');
      assert.ok(entry.reply_id?.startsWith('subreply-'), '子代理卡片应使用独立 reply_id');
      assert.equal(entry.worker_agent_name, '研究员');
      assert.equal(entry.event.type, 'REQUIRE_USER_CONFIRM');
      assert.equal(entry.event.tool_calls[0].name, 'Bash');
      assert.equal(entry.event.tool_calls[0].state, 'asking');
      assert.ok(entry.event.tool_calls[0].suggested_rules.length > 0, '卡片需要 suggested_rules');
      assert.ok(!existsSync(join(dir, 'worker-exec.txt')), '挂起期间不应执行命令');

      // 3) 用户答复 POST 到队长 /chat/（reply_id 是子代理的）
      const cr = await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId, session_id: sid,
          input: {
            type: 'USER_CONFIRM_RESULT', id: 'cs1', created_at: new Date().toISOString(), reply_id: entry.reply_id,
            confirm_results: [{ confirmed: true, tool_call: { id: 'wt1', name: 'Bash', input: '{}', state: 'asking', created_at: new Date().toISOString() }, rules: [] }]
          }
        })
      });
      assert.equal((await cr.json()).resolved, 1, '子代理挂起请求应被唤醒');

      // 4) 清卡事件 + 命令真正执行 + 队长正常收尾
      assert.ok(
        await sub.waitFor((ev) => ev.some((e) => e.type === 'CUSTOM' && e.name === 'subagent_user_confirm_result' && e.value?.reply_id === entry.reply_id)),
        '答复后应推 subagent_user_confirm_result 清卡'
      );
      assert.ok(await sub.waitFor((ev) => ev.some((e) => e.type === 'REPLY_END')), '队长应收尾');
      assert.ok(existsSync(join(dir, 'worker-exec.txt')), '确认后 worker 命令应执行');
      // worker 的确认不应混进队长的主确认队列（队长视图不该有 REQUIRE_USER_CONFIRM）
      assert.ok(!sub.events.some((e) => e.type === 'REQUIRE_USER_CONFIRM'), '子代理询问不该投影成队长主确认事件');
    } finally {
      sub.stop();
      globalThis.fetch = realFetch;
    }
  });

  await test('子代理 HITL：拒绝时命令不执行，清卡事件照常推送', async () => {
    const { sid, dir } = await makeTeamLeaderSession('subdeny');
    globalThis.fetch = makeTeamMock('touch denied-exec.txt');
    const sub = await listen(sid);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '组建团队执行命令' }] } })
      });
      assert.ok(
        await sub.waitFor((ev) => ev.some((e) => e.type === 'CUSTOM' && e.name === 'subagent_require_user_confirm')),
        '应收到 subagent_require_user_confirm'
      );
      const entry = sub.events.find((e) => e.type === 'CUSTOM' && e.name === 'subagent_require_user_confirm').value;

      const cr = await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId, session_id: sid,
          input: {
            type: 'USER_CONFIRM_RESULT', id: 'cs2', created_at: new Date().toISOString(), reply_id: entry.reply_id,
            confirm_results: [{ confirmed: false, tool_call: { id: 'wt1', name: 'Bash', input: '{}', state: 'asking', created_at: new Date().toISOString() }, rules: [] }]
          }
        })
      });
      assert.equal((await cr.json()).resolved, 1);
      assert.ok(
        await sub.waitFor((ev) => ev.some((e) => e.type === 'CUSTOM' && e.name === 'subagent_user_confirm_result' && e.value?.reply_id === entry.reply_id)),
        '拒绝同样要清卡'
      );
      assert.ok(await sub.waitFor((ev) => ev.some((e) => e.type === 'REPLY_END')), '拒绝后 worker/队长仍要收尾');
      assert.ok(!existsSync(join(dir, 'denied-exec.txt')), '拒绝后命令不得执行');
    } finally {
      sub.stop();
      globalThis.fetch = realFetch;
    }
  });

  await test('子代理 HITL：队长被中断时未答复合照被兜底清除（无幽灵卡片）', async () => {
    const { sid, dir } = await makeTeamLeaderSession('subabort');
    globalThis.fetch = makeTeamMock('touch abort-exec.txt');
    const sub = await listen(sid);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '组建团队执行命令' }] } })
      });
      assert.ok(
        await sub.waitFor((ev) => ev.some((e) => e.type === 'CUSTOM' && e.name === 'subagent_require_user_confirm')),
        '应收到 subagent_require_user_confirm'
      );
      const entry = sub.events.find((e) => e.type === 'CUSTOM' && e.name === 'subagent_require_user_confirm').value;

      // 用户点"停止"：队长 interrupt 必须同时清掉子代理卡片并按拒绝收口
      await realFetch(base + `/sessions/${sid}/interrupt`, { method: 'POST' });
      assert.ok(
        await sub.waitFor((ev) => ev.some((e) => e.type === 'CUSTOM' && e.name === 'subagent_user_confirm_result' && e.value?.reply_id === entry.reply_id), 6000),
        '中断应推清卡事件'
      );
      assert.ok(!existsSync(join(dir, 'abort-exec.txt')), '中断后命令不得执行');
    } finally {
      sub.stop();
      globalThis.fetch = realFetch;
    }
  });

  await test('权限规则 CRUD（允许清单持久化）', async () => {
    await realFetch(base + '/permission/rules', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"all":true}' });
    let d = await (await realFetch(base + '/permission/rules')).json();
    assert.equal(d.total, 0);

    let r = await realFetch(base + '/permission/rules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: { tool_name: 'bash', rule_content: 'npm test', behavior: 'allow' } })
    });
    d = await r.json();
    assert.equal(d.rule.tool_name, 'Bash', '工具名应归一化为 PascalCase');
    assert.equal(d.rules.length, 1);

    // 重复添加不产生重复项
    await realFetch(base + '/permission/rules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash', rule_content: 'npm test', behavior: 'allow' })
    });
    d = await (await realFetch(base + '/permission/rules')).json();
    assert.equal(d.total, 1);

    r = await realFetch(base + '/permission/rules', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index: 0 })
    });
    assert.equal(r.status, 200);
    d = await (await realFetch(base + '/permission/rules')).json();
    assert.equal(d.total, 0);
  });

  console.log('--- 检查点 / 会话检索 / git ---');

  await test('检查点：写入前自动快照，可按轮回滚', async () => {
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const dir = join(tmpdir(), `vega-asapi-ckpt-${sid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.txt'), 'v1');
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, permission_mode: 'bypass' })
    });

    let round = 0;
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路
      round++;
      if (round === 1) {
        return sse([{ tool_calls: [{ index: 0, id: 'e1', function: { name: 'Write', arguments: JSON.stringify({ path: 'keep.txt', content: 'v2' }) } }] }]);
      }
      return sse([{ content: '改好了' }]);
    };
    const sub = await listen(sid);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '改文件' }] } })
      });
      await sub.waitFor((ev) => ev.some((e) => e.type === 'REPLY_END'));
      assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'v2');
      const ck = await (await realFetch(base + `/sessions/${sid}/checkpoints`)).json();
      assert.ok(ck.checkpoints.length >= 1, '应至少有一个检查点');

      const turn = ck.checkpoints[0].turn;
      const rr = await realFetch(base + `/sessions/${sid}/checkpoints/${turn}/restore`, { method: 'POST' });
      assert.equal(rr.status, 200);
      assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'v1', '回滚应恢复到当轮之前的内容');
    } finally {
      sub.stop();
      globalThis.fetch = realFetch;
    }
  });

  await test('会话搜索 / 分支 / 导出', async () => {
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const dir = join(tmpdir(), `vega-asapi-search-${sid}`);
    mkdirSync(dir, { recursive: true });
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, permission_mode: 'bypass' })
    });

    globalThis.fetch = async () => sse([{ content: '独角兽关键词命中' }]);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '独角兽搜索用例' }] } })
      });
      // 等回复落盘
      for (let i = 0; i < 60; i++) {
        const h = await (await realFetch(base + `/sessions/${sid}/messages?agent_id=${agentId}`)).json();
        if (h.messages.length >= 2 && !h.is_running) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const found = await (await realFetch(base + `/sessions/search?q=${encodeURIComponent('独角兽')}`)).json();
      assert.ok(found.total >= 1, '搜索应命中');
      assert.ok(found.results.some((r2) => r2.id === sid));

      const fk = await (await realFetch(base + `/sessions/${sid}/fork`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '分支会话' })
      })).json();
      assert.ok(fk.session_id && fk.session_id !== sid);
      const forked = await (await realFetch(base + `/sessions/${fk.session_id}/messages?agent_id=${agentId}`)).json();
      assert.ok(forked.messages.length >= 1, '分支应继承历史');

      const md = await (await realFetch(base + `/sessions/${sid}/export?format=md`)).json();
      assert.equal(md.format, 'md');
      assert.ok(md.body.includes('独角兽'), '导出内容应含会话正文');
      const js = await (await realFetch(base + `/sessions/${sid}/export?format=json`)).json();
      assert.ok(JSON.parse(js.body).id === sid);
    } finally { globalThis.fetch = realFetch; }
  });

  await test('git：/admin/git-init + /workspace/status 真实状态 + /workspace/diff', async () => {
    // 环境守卫：git 不可用（如 Xcode 许可证未同意）时跳过，不把环境问题误报成代码回归
    const { execFileSync } = await import('node:child_process');
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
    catch { console.log('  ⏭ 跳过：系统 git 不可用（git --version 失败，检查 Xcode 许可证）'); return; }
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const dir = join(tmpdir(), `vega-asapi-git-${sid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, permission_mode: 'bypass' })
    });

    const init = await (await realFetch(base + '/admin/git-init', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid })
    })).json();
    assert.equal(init.status, 'ok');

    const st = await (await realFetch(base + `/workspace/status?session_id=${sid}`)).json();
    assert.equal(st.git.is_repo, true);
    assert.ok(st.git.branch, '应有分支名');
    assert.ok(st.git.dirty >= 1, '未跟踪文件应算作 dirty');

    // 提交后改动 a.txt → diff 能给出内容
    const { runGit } = await import('../src/tools/git.js');
    await runGit(['add', '-A'], dir);
    await runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], dir);
    writeFileSync(join(dir, 'a.txt'), 'hello\nchanged\n');
    const diff = await (await realFetch(base + `/workspace/diff?session_id=${sid}`)).json();
    assert.match(diff.diff, /\+changed/, 'diff 应包含新增行');
  });

  await test('终端：create → write 回显 → SSE 流 + 重连回放 → kill → 已退出 404', async () => {
    const dir = join(tmpdir(), `vega-asapi-term-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const cr = await (await realFetch(base + '/terminal/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, shell: '/bin/sh' })
    })).json();
    assert.ok(/^[\w-]+$/.test(cr.id), '应返回终端 id');
    assert.equal(cr.cwd, realpathSync(dir), 'cwd 应做 realpath 归一');

    // fetch-SSE 读流（与 /sessions/:id/stream 的 listen 模式同构）
    const ac = new AbortController();
    const res = await realFetch(base + `/terminal/${cr.id}/stream`, { signal: ac.signal });
    assert.equal(res.status, 200);
    const events = [];
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
        }
      } catch { /* aborted */ }
    })();
    const waitFor = async (pred, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
      return false;
    };

    await realFetch(base + `/terminal/${cr.id}/write`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'echo hi-terminal-$((40+2))\n' })
    });
    assert.ok(await waitFor(() => events.some((e) => e.type === 'data' && e.data.includes('hi-terminal-42')), 8000),
      'SSE 应收到 echo 回显');

    // 面板重开回放：新连接应先收到 replay 帧（历史输出）
    const ac2 = new AbortController();
    const res2 = await realFetch(base + `/terminal/${cr.id}/stream`, { signal: ac2.signal });
    const reader2 = res2.body.getReader();
    let frames2 = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      const { done, value } = await reader2.read();
      if (done) break;
      frames2 += dec.decode(value, { stream: true });
      if (frames2.includes('"type":"replay"') && frames2.includes('hi-terminal-42')) break;
    }
    ac2.abort();
    assert.ok(frames2.includes('"type":"replay"') && frames2.includes('hi-terminal-42'), '重连应先收到 replay 历史');

    // 非法写入 → 422；kill → exit 事件；退出后 write → 404；未知终端 stream → 404
    const bad = await realFetch(base + `/terminal/${cr.id}/write`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 42 })
    });
    assert.equal(bad.status, 422, 'data 非字符串应 422');
    await realFetch(base + `/terminal/${cr.id}/kill`, { method: 'POST' });
    assert.ok(await waitFor(() => events.some((e) => e.type === 'exit'), 8000), 'SSE 应收到 exit 事件');
    const wr = await realFetch(base + `/terminal/${cr.id}/write`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'echo again\n' })
    });
    assert.equal(wr.status, 404, '已退出终端 write 应 404');
    const kr = await realFetch(base + `/terminal/${cr.id}/kill`, { method: 'POST' });
    assert.equal(kr.status, 404, '重复 kill 应 404');
    const gr = await realFetch(base + '/terminal/does-not-exist/stream');
    assert.equal(gr.status, 404, '未知终端 stream 应 404');
    ac.abort();
  });

  await test('自定义斜杠命令 + 额外工具目录 + 本地模型探测端点', async () => {
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const dir = join(tmpdir(), `vega-asapi-cmd-${sid}`);
    mkdirSync(join(dir, '.cocode', 'commands'), { recursive: true });
    mkdirSync(join(dir, '.cocode', 'tools'), { recursive: true });
    writeFileSync(join(dir, '.cocode', 'commands', 'review.md'), '---\ndescription: 审查改动\n---\n请审查这些改动：$ARGUMENTS');
    writeFileSync(join(dir, '.cocode', 'tools', 'hello.js'), 'export default { name: "HelloTool", description: "示例", parameters: { type: "object", properties: {} }, async execute() { return "hi"; } };');
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir })
    });

    const cmds = await (await realFetch(base + `/commands?session_id=${sid}`)).json();
    assert.ok(cmds.some((c) => c.name === 'review' && c.description === '审查改动'), '项目级命令应被发现');

    const tools = await (await realFetch(base + `/tools/extra?session_id=${sid}`)).json();
    assert.ok(tools.some((t) => t.name === 'HelloTool'), '项目级额外工具应被加载（extraTools 不再是空转）');

    // 本地模型探测：本地没起服务时应返回空数组而不是 5xx
    const lm = await realFetch(base + '/admin/local-models');
    assert.equal(lm.status, 200);
    const lmBody = await lm.json();
    assert.ok(Array.isArray(lmBody.providers));
  });


  // ---------- 代码索引 / LSP / 钩子 / 运行记录（HTTP 层）----------
  await test('索引端点：能重建索引并回报规模', async () => {
    const dir = join(tmpdir(), `cocode-idx-http-${Date.now()}`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.js'), 'export function indexedThing() {}\nexport const other = 1;\n');
    const { session_id } = await (await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    })).json();
    await realFetch(base + `/sessions/${session_id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir })
    });

    const r = await realFetch(base + `/admin/index?session_id=${session_id}`);
    assert.equal(r.status, 200);
    const before = await r.json();
    assert.equal(before.cwd, dir);
    assert.equal(typeof before.semantic.indexed, 'boolean');

    const rb = await realFetch(base + '/admin/index', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, force: true })
    });
    assert.equal(rb.status, 200);
    const built = await rb.json();
    assert.ok(built.symbols.count >= 2, '应索引到导出符号: ' + JSON.stringify(built.symbols));
    assert.ok(built.semantic.tokens > 0, '倒排索引应有词条');

    // 无 cwd 时必须明确报 422，而不是悄悄退回进程 cwd
    const bad = await realFetch(base + '/admin/index');
    assert.equal(bad.status, 422);
    rmSync(dir, { recursive: true, force: true });
  });

  await test('LSP 探测：返回已安装清单与当前配置（而不是 404）', async () => {
    const r = await realFetch(base + '/admin/lsp');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.installed));
    assert.ok(body.configured !== undefined);
  });

  await test('钩子：/hooks 报告生效清单，/hooks/trust 写入信任列表', async () => {
    const dir = join(tmpdir(), `cocode-hooks-http-${Date.now()}`);
    mkdirSync(join(dir, '.cocode'), { recursive: true });
    writeFileSync(join(dir, '.cocode', 'hooks.json'), JSON.stringify({
      PreToolUse: [{ matcher: 'Bash', command: 'echo hi' }]
    }));
    const { session_id } = await (await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    })).json();
    await realFetch(base + `/sessions/${session_id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir })
    });

    const r = await realFetch(base + `/hooks?session_id=${session_id}`);
    assert.equal(r.status, 200);
    const before = await r.json();
    assert.equal(before.projectHooksPresent, true, '应检测到项目钩子');
    assert.equal(before.projectHooksTrusted, false, '默认不信任');
    assert.equal(before.rows.length, 0, '未信任时不该出现在生效清单里');

    const trust = await realFetch(base + '/hooks/trust', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, trust: true })
    });
    assert.equal(trust.status, 200);

    const after = await (await realFetch(base + `/hooks?session_id=${session_id}`)).json();
    assert.equal(after.projectHooksTrusted, true);
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].command, 'echo hi');

    // 撤销信任
    await realFetch(base + '/hooks/trust', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, trust: false })
    });
    const revoked = await (await realFetch(base + `/hooks?session_id=${session_id}`)).json();
    assert.equal(revoked.projectHooksTrusted, false);
    rmSync(dir, { recursive: true, force: true });
  });

  await test('运行记录：聊天后能列出 trace、拿到详情与 markdown 时间线', async () => {
    const dir = join(tmpdir(), `cocode-trace-http-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const { session_id: sid } = await (await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    })).json();
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, permission_mode: 'bypass' })
    });
    // 上游必须打桩，否则这轮会真的去连配置里的 baseURL（本地测试环境没有 key）
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路
      return sse([{ content: '好，我来写' }]);
    };
    const sub = await listen(sid);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '写个文件' }] } })
      });
      const ended = await sub.waitFor((ev) => ev.some((e) => e.type === 'REPLY_END'), 6000);
      assert.ok(ended, '本轮应正常结束（收到 REPLY_END），否则 trace 无从产生');
    } finally {
      sub.stop();
      globalThis.fetch = prevFetch;
    }

    const list = await (await realFetch(base + `/traces?session_id=${sid}`)).json();
    assert.ok(list.traces.length >= 1, '应有运行记录: ' + JSON.stringify(list.traces));
    const t = list.traces[0];
    assert.equal(t.reason, 'completed');

    const detail = await (await realFetch(base + `/traces/${encodeURIComponent(t.id)}`)).json();
    assert.equal(detail.id, t.id);
    assert.ok(detail.turns.length >= 1, '应至少一轮响应');
    assert.ok(detail.start?.meta?.model, '应记录用了哪个模型');

    const md = await (await realFetch(base + `/traces/${encodeURIComponent(t.id)}/markdown`)).json();
    assert.match(md.markdown, /# Trace /);
    assert.match(md.markdown, /时间线/);

    const ev = await (await realFetch(base + `/traces/${encodeURIComponent(t.id)}/events`)).json();
    assert.ok(Array.isArray(ev.lines) && ev.lines.length > 0, '回放需要原始事件流');

    const missing = await realFetch(base + '/traces/no-such-session/no-such-run');
    assert.equal(missing.status, 404);
    rmSync(dir, { recursive: true, force: true });
  });

  await test('/admin/runtime 覆盖新开关（钩子/追踪/变更感知）', async () => {
    const r = await realFetch(base + '/admin/runtime', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ traceEnabled: false, hooksEnabled: false, changesAware: false, changesLimit: 5 })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.traceEnabled, false);
    assert.equal(body.hooksEnabled, false);
    assert.equal(body.changesAware, false);
    assert.equal(body.changesLimit, 5);

    const back = await (await realFetch(base + '/admin/runtime', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ traceEnabled: true, hooksEnabled: true, changesAware: true, changesLimit: 12 })
    })).json();
    assert.equal(back.traceEnabled, true);
    assert.equal(back.changesLimit, 12);
  });

  await test('HITL 顺序：TOOL_CALL_START 必须先于 REQUIRE_USER_CONFIRM（否则卡片不弹、工具调用空转）', async () => {
    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const dir = join(tmpdir(), `vega-asapi-order-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, permission_mode: 'default' })
    });

    let round = 0;
    globalThis.fetch = async (_u, init) => {
      if (isTitleCall(init)) return sse([{ content: '' }]); // 取名调用旁路
      round++;
      if (round === 1) {
        return sse([{ tool_calls: [{ index: 0, id: 'ord1', function: { name: 'Write', arguments: JSON.stringify({ path: 'x.txt', content: 'x' }) } }] }]);
      }
      return sse([{ content: '好的' }]);
    };

    const sub = await listen(sid);
    try {
      await realFetch(base + '/chat/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, session_id: sid, input: { content: [{ type: 'text', text: '写个文件' }] } })
      });
      const got = await sub.waitFor((ev) => ev.some((e) => e.type === 'REQUIRE_USER_CONFIRM'));
      assert.ok(got, '应收到 REQUIRE_USER_CONFIRM; got: ' + sub.events.map((e) => e.type).join(','));

      const types = sub.events.map((e) => e.type);
      const iCall = types.indexOf('TOOL_CALL_START');
      const iConfirm = types.indexOf('REQUIRE_USER_CONFIRM');
      assert.ok(iCall >= 0, '应有 TOOL_CALL_START: ' + types.join(','));
      // 这是本次修复的核心不变式。确认事件曾经从 permissionAsk 里旁路直推，
      // 抢在 channel 队列里还没被消费的 tool-start 之前到达前端，于是
      // appendEvent 找不到 tool_call 块（SDK 是 `if (b)` 静默跳过）：
      // 卡片不出现，工具调用永远停在 pending，只有重进会话读 display 快照才看得见。
      assert.ok(
        iCall < iConfirm,
        `TOOL_CALL_START(第 ${iCall} 条) 必须在 REQUIRE_USER_CONFIRM(第 ${iConfirm} 条) 之前；` +
        '顺序反了前端就没法把块翻成 asking。实际顺序: ' + types.join(',')
      );

      // 顺序正确的一个直接后果：确认事件引用的就是前面那块
      assert.equal(sub.events[iConfirm].tool_calls[0].id, sub.events[iCall].tool_call_id);

      // 再用真实 SDK 的 appendEvent 回放，直接验证「卡片能渲染」这个用户可见的性质。
      // 前端 ChatContent 就是从尾消息里筛 state==='asking' 的 tool_call 来画卡片的。
      let appendEvent = null, AssistantMsg = null;
      try {
        ({ appendEvent, AssistantMsg } = await import(
          '../../desktop/frontend/node_modules/@agentscope-ai/agentscope/dist/message/index.mjs'
        ));
      } catch { /* 前端依赖没装时跳过这一段 */ }
      if (appendEvent) {
        const msgs = [];
        let cur = null;
        const warns = [];
        const origWarn = console.warn;
        console.warn = (...a) => warns.push(a.join(' '));
        try {
          for (const e of sub.events) {
            if (e.type === 'CUSTOM') continue;
            if (e.type === 'REPLY_START') {
              const m = AssistantMsg({ id: e.reply_id, name: e.name, content: [] });
              msgs.push(m); cur = m;
            } else if (cur) {
              appendEvent(cur, e);
              if (e.type === 'REPLY_END') cur = null;
            }
          }
        } finally { console.warn = origWarn; }

        const tail = msgs[msgs.length - 1];
        const blocks = (tail?.content ?? []);
        assert.ok(tail && tail.role === 'assistant', '尾消息应是助手回复');
        const asking = blocks.filter((b) => b.type === 'tool_call' && b.state === 'asking');
        assert.equal(
          asking.length, 1,
          '尾消息应恰好有一个 asking 的 tool_call（ConfirmCard 从这里读）；' +
          '实际块=' + JSON.stringify(blocks.map((b) => [b.type, b.state])) +
          ' SDK 警告=' + (warns.join('|') || '无')
        );
      }
    } finally {
      sub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('Git 深度集成 HTTP：分支/工作树/暂存/提交/日志 全链路', async () => {
    const { execFileSync } = await import('node:child_process');
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
    catch { console.log('  ⏭ 跳过：系统 git 不可用'); return; }

    const mk = await realFetch(base + '/sessions/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId })
    });
    const { session_id: sid } = await mk.json();
    const dir = join(tmpdir(), `vega-asapi-git2-${sid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f.txt'), '1\n');
    await realFetch(base + `/sessions/${sid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir })
    });
    await realFetch(base + '/admin/git-init', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid })
    });
    const { runGit } = await import('../src/tools/git.js');
    await runGit(['config', 'user.email', 't@t'], dir);
    await runGit(['config', 'user.name', 't'], dir);
    await runGit(['add', '-A'], dir);
    await runGit(['commit', '-qm', 'init'], dir);

    // 1) 分支列表
    let br = await (await realFetch(base + `/git/branches?session_id=${sid}`)).json();
    assert.ok(br.branches.some((b) => b.name && b.current), '应有当前分支');

    // 2) 建分支 + 切换 + 切回 + 删除
    await realFetch(base + '/git/branches', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, name: 'feat-x' })
    });
    br = await (await realFetch(base + `/git/branches?session_id=${sid}`)).json();
    assert.ok(br.branches.some((b) => b.name === 'feat-x'), 'feat-x 应已创建');
    const sw = await (await realFetch(base + '/git/branches/feat-x/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid })
    })).json();
    assert.equal(sw.status, 'ok');
    assert.equal(sw.git.branch, 'feat-x');
    await realFetch(base + '/git/branches/main/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid })
    });
    const del = await realFetch(base + '/git/branches/feat-x?session_id=' + sid, { method: 'DELETE' });
    assert.equal(del.status, 200, '删除分支应 200');

    // 3) 工作树：建 + 列 + 删
    const wtPath = join(dir, '..', `cocode-wt-${sid}`);
    rmSync(wtPath, { recursive: true, force: true });
    const cwt = await realFetch(base + '/git/worktrees', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, path: wtPath, branch: 'dev-wt' })
    });
    assert.equal(cwt.status, 200, '建工作树应 200');
    const wts = await (await realFetch(base + `/git/worktrees?session_id=${sid}`)).json();
    assert.ok(wts.worktrees.some((w) => w.branch === 'dev-wt'), '列表应有 dev-wt');
    const rwt = await realFetch(base + '/git/worktrees?session_id=' + sid + '&path=' + encodeURIComponent(wtPath), {
      method: 'DELETE'
    });
    assert.equal(rwt.status, 200, '删工作树应 200');
    rmSync(wtPath, { recursive: true, force: true });

    // 4) 暂存 + 状态 + 提交 + 日志
    writeFileSync(join(dir, 'g.txt'), '2\n');
    await realFetch(base + '/git/stage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, paths: ['g.txt'] })
    });
    const sf = await (await realFetch(base + `/git/status-files?session_id=${sid}`)).json();
    assert.ok(sf.staged.some((f) => f.path === 'g.txt'), 'g.txt 应已暂存');
    const cm = await (await realFetch(base + '/git/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, message: 'add g' })
    })).json();
    assert.equal(cm.status, 'ok');
    const lg = await (await realFetch(base + `/git/log?session_id=${sid}&limit=5`)).json();
    assert.ok(lg.commits.some((c) => c.subject === 'add g'), '日志应有 add g');
  });

  srv.close();
  rmSync(TEST_HOME, { recursive: true, force: true });
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
