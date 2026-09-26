// CoCode core 全链路测试（无需真实模型：mock fetch 模拟 SSE）
// 运行：node packages/core/test/run.js
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 数据根重定向到临时目录：测试绝不读写用户真实的 ~/.cocode（配置/会话/检查点）。
// 必须在 import 任何 core 模块之前设置。
process.env.COCODE_HOME = mkdtempSync(join(tmpdir(), 'cocode-home-'));

const CORE = '../src/';
const {
  readTool, writeTool, editTool, globTool, grepTool, bashTool
} = await import(CORE + 'tools/builtin.js');
const { estimateTokens, evictToolOutputs, compactMessages, estimateMessagesTokens } = await import(CORE + 'context.js');
const { createSession, listSessions, loadSession, saveSession, deleteSession } = await import(CORE + 'session.js');
const { runAgent } = await import(CORE + 'agent.js');
const { startServer } = await import(CORE + 'server.js');
const { loadConfig } = await import(CORE + 'config.js');
const { loadProjectContext, buildSystemPrompt } = await import(CORE + 'prompt.js');
const { sanitizeLoneSurrogates, chatCompletion } = await import(CORE + 'model.js');
const { decidePermission } = await import(CORE + 'agent.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('--- 工具系统 ---');
const tmp = mkdtempSync(join(tmpdir(), 'cocode-test-'));
const ctx = { cwd: tmp, toolOutputLimit: 6000 };

await test('Write 创建文件 / 覆盖时给出 diff 预览', async () => {
  const r = await writeTool.execute({ path: 'a/hello.txt', content: 'hello cocode\nline2' }, ctx);
  assert.match(r.text, /已创建 a\/hello\.txt/);
  // 新建与覆盖是两条不同文案，覆盖时必须带 +/- 预览（"先看改动"的最低要求）
  await writeTool.execute({ path: 'a/other.txt', content: 'x\ny\nz' }, ctx);
  const r2 = await writeTool.execute({ path: 'a/other.txt', content: 'x\nY\nz' }, ctx);
  assert.match(r2.text, /已写入 a\/other\.txt/);
  assert.match(r2.text, /\+ Y/);
  assert.match(r2.text, /- y/);
  // metadata.diff：标准 unified diff（前端 +N/-M 徽标与 diff 卡片的数据源）
  assert.ok(r2.meta?.diff?.startsWith('--- a/'), '覆盖写入应带 unified diff 头');
  assert.ok(r2.meta.added === 1 && r2.meta.removed === 1);
});

await test('Read 带行号读取', async () => {
  const r = await readTool.execute({ path: 'a/hello.txt' }, ctx);
  assert.match(r, /1\thello cocode/);
  assert.match(r, /共 2 行/);
});

await test('Edit 精确替换（唯一匹配）', async () => {
  const r = await editTool.execute({ path: 'a/hello.txt', old_string: 'hello cocode', new_string: 'hello world cocode' }, ctx);
  assert.match(r.text, /已修改/);
  const r2 = await readTool.execute({ path: 'a/hello.txt' }, ctx);
  assert.match(r2, /hello world cocode/);
});

await test('Edit 非唯一报错', async () => {
  writeFileSync(join(tmp, 'a/hello.txt'), 'x x x');
  const r = await editTool.execute({ path: 'a/hello.txt', old_string: 'x', new_string: 'y' }, ctx);
  assert.match(r, /3 次/);
});

await test('Edit replace_all → metadata.diff 多 hunk 且行号正确', async () => {
  const body = [...Array(20)].map((_, i) => `line${i + 1}`).join('\n');
  writeFileSync(join(tmp, 'a/multi.txt'), body);
  const r = await editTool.execute(
    { path: 'a/multi.txt', old_string: 'line3', new_string: 'L3', replace_all: true }, ctx);
  assert.ok(r.text.includes('已修改'));
  const u = r.meta;
  assert.equal(u.added, 1); assert.equal(u.removed, 1);
  const hunks = u.diff.split('\n').filter((l) => l.startsWith('@@'));
  assert.equal(hunks.length, 1, '单处出现应只有 1 个 hunk');
  assert.match(hunks[0], /@@ -1,6 \+1,6 @@/, 'hunk 行号应为标准 unified 坐标');
  // 两处相距远的多 hunk：replace_all 替换 line3 与 line17（同一 old_string 做不到，
  // 改用两处出现的 old_string）
  const body2 = ['aaa', 'mid1', 'mid2', 'mid3', 'mid4', 'mid5', 'mid6', 'mid7', 'mid8', 'aaa', 'tail'].join('\n');
  writeFileSync(join(tmp, 'a/two.txt'), body2);
  const r2 = await editTool.execute(
    { path: 'a/two.txt', old_string: 'aaa', new_string: 'ZZZ', replace_all: true }, ctx);
  const hunks2 = r2.meta.diff.split('\n').filter((l) => l.startsWith('@@'));
  assert.equal(hunks2.length, 2, '两处出现应产生 2 个 hunk');
  assert.match(hunks2[0], /@@ -1,4 \+1,4 @@/);
  assert.match(hunks2[1], /@@ -7,5 \+7,5 @@/, '第二个 hunk 的 old 侧行号不应被前面替换漂移');
  assert.equal(r2.meta.added, 2); assert.equal(r2.meta.removed, 2);
  // 新文件：/dev/null 头 + 纯 + 行
  const w = await writeTool.execute({ path: 'a/brand-new.txt', content: 'n1\nn2' }, ctx);
  assert.ok(w.meta.diff.startsWith('--- /dev/null'));
  assert.ok(w.meta.diff.includes('@@ -0,0 +1,2 @@'));
});

await test('Glob 匹配', async () => {
  const r = await globTool.execute({ pattern: 'a/*.txt' }, ctx);
  assert.match(r, /hello\.txt/);
});

await test('Grep 内容搜索', async () => {
  writeFileSync(join(tmp, 'needle.txt'), 'here is cocode-needle-42\nsecond line');
  const r = await grepTool.execute({ pattern: 'cocode-needle' }, ctx);
  assert.match(r, /needle\.txt:1:/);
});

await test('Bash 执行与 exit_code', async () => {
  const r = await bashTool.execute({ command: 'echo cocode-ok && echo err >&2; exit 0' }, ctx);
  assert.match(r, /exit_code: 0/);
  assert.match(r, /cocode-ok/);
});

console.log('--- 路径沙箱 ---');
await test('沙箱：绝对路径越界被拒', async () => {
  const r = await readTool.execute({ path: '/etc/hosts' }, ctx);
  assert.match(r, /路径越界/);
});
await test('沙箱：../../ 越界被拒', async () => {
  const r = await writeTool.execute({ path: '../../evil.txt', content: 'x' }, ctx);
  assert.match(r, /路径越界/);
  assert.ok(!existsSync(join(tmp, '..', '..', 'evil.txt')));
});
await test('沙箱：符号链接指向外部时按真实路径拒绝', async () => {
  const link = join(tmp, 'link-out');
  try {
    const { symlinkSync } = await import('node:fs');
    symlinkSync('/etc', link, 'dir');
    const r = await readTool.execute({ path: 'link-out/hosts' }, ctx);
    assert.match(r, /路径越界/);
  } catch (e) {
    if (e.code === 'EPERM') return; // 无权限建符号链接的环境跳过
    throw e;
  }
});

console.log('--- 上下文管理 ---');
await test('token 估算（中文≈1字/token）', () => {
  const t = estimateTokens('你好世界');
  assert.ok(t >= 3 && t <= 6, `got ${t}`);
  const t2 = estimateTokens('abcdefghij'); // 10 ascii ≈ 2-3 tokens
  assert.ok(t2 >= 2 && t2 <= 4, `got ${t2}`);
});

await test('驱逐旧工具输出', () => {
  const mk = (i) => [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' + i },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c' + i, content: 'x'.repeat(3000) }
  ];
  const messages = [];
  for (let i = 0; i < 8; i++) messages.push(...mk(i));
  messages.push({ role: 'user', content: 'final' });
  const { messages: out, evicted } = evictToolOutputs(messages, 3000, 4);
  assert.ok(evicted === 4, `evicted=${evicted}`);
  const toolMsgs = out.filter((m) => m.role === 'tool');
  assert.match(toolMsgs[0].content, /已驱逐/);
  assert.equal(toolMsgs[7].content.length, 3000); // 最近4条保留
  assert.equal(messages[3].content.length, 3000); // 原数组未被修改
});

await test('摘要压缩', async () => {
  const messages = [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: 'm'.repeat(500) + i })),
    { role: 'user', content: 'final question' }
  ];
  const { messages: out, compacted } = await compactMessages(messages, {
    budget: 100,
    summarize: async () => '这是纪要',
    keepTail: 2
  });
  assert.ok(compacted);
  assert.equal(out.length, 4); // head + 纪要 + 2 tail
  assert.match(out[1].content, /这是纪要/);
});

console.log('--- 会话持久化 ---');
await test('会话 CRUD', () => {
  const s = createSession();
  s.messages.push({ role: 'user', content: '帮我写个测试程序hello' });
  saveSession(s);
  const loaded = loadSession(s.id);
  assert.equal(loaded.messages.length, 1);
  assert.match(loaded.title, /帮我写个测试程序/); // 标题自动生成
  assert.ok(listSessions().some((x) => x.id === s.id));
  deleteSession(s.id);
  assert.equal(loadSession(s.id), null);
});

console.log('--- 模型内容 sanitize ---');
await test('sanitizeLoneSurrogates：合法 surrogate pair 不动', () => {
  const ok = '普通文本 + 😊 emoji + 后面'; // \uD83D\uDE0A 配对
  assert.equal(sanitizeLoneSurrogates(ok), ok);
});
await test('sanitizeLoneSurrogates：lone high surrogate → FFFD', () => {
  const bad = '前面\ud83d…后面'; // 半截 emoji，紧跟 ellipsis
  const out = sanitizeLoneSurrogates(bad);
  assert.equal(out, '前面\uFFFD…后面');
  assert.ok(!/[\uD800-\uDFFF]/.test(out), '不应再有 surrogate 范围字符');
});
await test('sanitizeLoneSurrogates：lone low surrogate → FFFD', () => {
  const bad = '前面\ude0a后面';
  const out = sanitizeLoneSurrogates(bad);
  assert.equal(out, '前面\uFFFD后面');
});
await test('sanitizeLoneSurrogates：非字符串 / 空串 短路', () => {
  assert.equal(sanitizeLoneSurrogates(null), null);
  assert.equal(sanitizeLoneSurrogates(undefined), undefined);
  assert.equal(sanitizeLoneSurrogates(''), '');
  assert.equal(sanitizeLoneSurrogates(42), 42);
});
await test('chatCompletion 上送 body 不含 lone surrogate（端到端）', async () => {
  const origFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_u, init) => {
    capturedBody = init?.body;
    return new Response(
      'data: {"choices":[{"delta":{"content":"OK"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  try {
    await chatCompletion(
      { baseURL: 'http://x', apiKey: 'k', model: 'm', temperature: 0, maxTurns: 1 },
      {
        messages: [
          { role: 'system', content: 'sys' },
          // 13 条 user/assistant（凑齐 messages[13]，复现 column 12451 报错语境）
          ...Array.from({ length: 12 }, () => ({ role: 'user', content: 'foo' })),
          { role: 'user', content: '需要哪一项直接说就行 \ud83d…看看有哪些Cod' },
        ],
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.ok(capturedBody, 'fetch 未被调用');
  // 验证 wire 后 body 不再含任何 surrogate 范围字符
  assert.ok(!/[\uD800-\uDFFF]/.test(capturedBody), `body 中仍有 lone surrogate: ${capturedBody}`);
  // 验证 lone surrogate 已经被替换成 FFFD
  assert.ok(capturedBody.includes('\ufffd'), '应至少出现一个 U+FFFD');
});

console.log('--- Agent 循环（mock SSE）---');
function sse(chunks) {
  const events = chunks.map((c) => ({ choices: [{ delta: c }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  events.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const payload = 'data: ' + events.map((e) => JSON.stringify(e)).join('\ndata: ') + '\ndata: [DONE]\n\n';
  return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
await test('Agent 两轮：工具调用 → 总结', async () => {
  const origFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return sse([{ tool_calls: [{ index: 0, id: 't1', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }] }]);
    return sse([{ content: '任务完成：执行了 echo hi' }]);
  };
  try {
    // permissionMode 显式钉死：这个用例只验工具调用链路，不该随用户配置漂移
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const messages = [];
    const events = [];
    messages.push({ role: 'user', content: '执行 echo hi' });
    for await (const ev of runAgent({ cfg, cwd: tmp, messages, permissionMode: 'bypass' })) events.push(ev);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool-start'));
    assert.ok(types.includes('tool-result'));
    const tr = events.find((e) => e.type === 'tool-result');
    assert.match(tr.result, /hi/);
    const done = events.find((e) => e.type === 'done');
    assert.equal(done.reason, 'completed');
    // 消息数组被就地更新，可持久化
    assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
    assert.equal(messages.at(-1).content, '任务完成：执行了 echo hi');
    assert.equal(done.totalUsage.prompt_tokens, 20);
  } finally { globalThis.fetch = origFetch; }
});

await test('默认未选工作目录：本地工具必须拒绝，不能隐式扩展到家目录', async () => {
  const origFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      return sse([{ tool_calls: [{ index: 0, id: 'no-cwd-bash', function: { name: 'Bash', arguments: '{"command":"echo must-not-run"}' } }] }]);
    }
    return sse([{ content: '请先选择工作目录。' }]);
  };
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    assert.equal(cfg.defaultScopeFullDisk, false, '安全默认值不得给未选目录的会话家目录权限');
    const events = [];
    for await (const ev of runAgent({ cfg, messages: [{ role: 'user', content: '执行命令' }], permissionMode: 'bypass' })) events.push(ev);
    const result = events.find((ev) => ev.type === 'tool-result');
    assert.equal(result?.ok, false);
    assert.match(result?.result || '', /未选择工作目录/);
    assert.equal(events.find((ev) => ev.type === 'done')?.reason, 'completed');
  } finally { globalThis.fetch = origFetch; }
});

await test('交付审查：仅在有写入或执行动作后运行，并把通过结果公开为事件', async () => {
  const origFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) return sse([{ tool_calls: [{ index: 0, id: 'review-tool', function: { name: 'Write', arguments: '{"path":"review-output.txt","content":"changed"}' } }] }]);
    if (call === 2) return sse([{ content: '修改完成并已验证。' }]);
    return sse([{ content: JSON.stringify({ passed: true, issues: [], reason: '工具执行和交付说明完整' }) }]);
  };
  try {
    const cfg = {
      ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock',
      review: { enabled: true, max_rounds: 1, min_turns: 1, only_after_mutation: true, checklist: ['是否验证变更？'] }
    };
    const events = [];
    for await (const ev of runAgent({ cfg, cwd: tmp, messages: [{ role: 'user', content: '执行命令后交付' }], permissionMode: 'bypass' })) events.push(ev);
    assert.equal(call, 3, `应在正常收尾后再调用一次 critic；events=${JSON.stringify(events.filter((e) => e.type.startsWith('review-') || e.type === 'error'))}`);
    assert.ok(events.some((e) => e.type === 'review-start' && !e.skipped));
    assert.ok(events.some((e) => e.type === 'review-result' && e.passed));
    assert.equal(events.find((e) => e.type === 'done')?.reason, 'completed');
  } finally { globalThis.fetch = origFetch; }
});

await test('交付审查：失败工具必须标为 FAIL，并驱动返工后重新审查', async () => {
  const origFetch = globalThis.fetch;
  let call = 0;
  let criticSawFailure = false;
  let criticRequest = '';
  const outputPath = 'review-recovery-output.txt';
  globalThis.fetch = async (_url, init) => {
    call++;
    if (call === 1) return sse([{ tool_calls: [{ index: 0, id: 'failed-write', function: { name: 'Write', arguments: '{"path":"../outside-review.txt","content":"bad"}' } }] }]);
    if (call === 2) return sse([{ content: '已经完成。' }]);
    if (call === 3) {
      const request = JSON.parse(init.body);
      criticRequest = JSON.stringify(request.messages);
      criticSawFailure = request.messages.some((m) => String(m.content).includes('[tool-result] Write → FAIL'));
      return sse([{ content: JSON.stringify({ passed: false, issues: ['写入失败，请重试'], reason: '未交付' }) }]);
    }
    if (call === 4) return sse([{ tool_calls: [{ index: 0, id: 'repaired-write', function: { name: 'Write', arguments: JSON.stringify({ path: outputPath, content: 'repaired' }) } }] }]);
    if (call === 5) return sse([{ content: '已修复并写入。' }]);
    return sse([{ content: JSON.stringify({ passed: true, issues: [], reason: '重新写入成功' }) }]);
  };
  try {
    const cfg = {
      ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock',
      review: { enabled: true, max_rounds: 1, min_turns: 1, only_after_mutation: true, checklist: ['写入是否成功？'] }
    };
    const events = [];
    for await (const ev of runAgent({ cfg, cwd: tmp, messages: [{ role: 'user', content: '写入文件' }], permissionMode: 'bypass' })) events.push(ev);
    assert.equal(call, 6);
    assert.equal(criticSawFailure, true, `审查轨迹应明确标记失败工具：${criticRequest.slice(-1200)}`);
    assert.ok(events.some((ev) => ev.type === 'review-redo'));
    assert.ok(events.some((ev) => ev.type === 'review-result' && ev.passed));
    assert.equal(readFileSync(join(tmp, outputPath), 'utf8'), 'repaired');
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('模型服务失败以 error 和 done(error) 结束，不冒充完成', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'mock unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const events = [];
    for await (const ev of runAgent({ cfg, cwd: tmp, messages: [{ role: 'user', content: '修复代码' }], permissionMode: 'bypass' })) events.push(ev);
    assert.ok(events.some((ev) => ev.type === 'error' && ev.error), JSON.stringify(events));
    assert.equal(events.at(-1)?.type, 'done');
    assert.equal(events.at(-1)?.reason, 'error');
  } finally { globalThis.fetch = origFetch; }
});

await test('Bash 非零退出码在事件和审查上下文中保持失败状态', async () => {
  const origFetch = globalThis.fetch;
  let call = 0;
  let criticSawFailure = false;
  globalThis.fetch = async (_url, init) => {
    call++;
    if (call === 1) return sse([{ tool_calls: [{ index: 0, id: 'failed-bash', function: { name: 'Bash', arguments: JSON.stringify({ command: 'node -e "process.exit(7)"' }) } }] }]);
    if (call === 2) return sse([{ content: '测试已经通过。' }]);
    const request = JSON.parse(init.body);
    criticSawFailure = request.messages.some((m) => String(m.content).includes('[tool-result] Bash → FAIL'));
    return sse([{ content: JSON.stringify({ passed: true, issues: [], reason: '测试状态已核对' }) }]);
  };
  try {
    const cfg = {
      ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock',
      review: { enabled: true, max_rounds: 0, min_turns: 1, only_after_mutation: true, checklist: ['测试是否通过？'] }
    };
    const messages = [{ role: 'user', content: '运行验证命令' }];
    const events = [];
    for await (const ev of runAgent({ cfg, cwd: tmp, messages, permissionMode: 'bypass' })) events.push(ev);
    assert.equal(events.find((ev) => ev.type === 'tool-result')?.ok, false);
    assert.equal(messages.find((m) => m.role === 'tool')?.tool_state, 'error');
    assert.equal(criticSawFailure, true);
  } finally { globalThis.fetch = origFetch; }
});

await test('CLI 模型连接失败返回非零退出码', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../../cli/src/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '执行测试任务'], {
    cwd: tmp,
    env: { ...process.env, COCODE_BASE_URL: 'http://127.0.0.1:1/v1', COCODE_API_KEY: 'test', COCODE_MODEL: 'mock' },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 1, `CLI 不应把模型错误报告为成功：${result.stdout}\n${result.stderr}`);
});

await test('上下文自动压缩：超预算触发 compact，历史被摘要但消息仍可持久化', async () => {
  const origFetch = globalThis.fetch;
  // 前 5 轮持续返回工具调用（每次产出约 3000 字符工具输出撑爆预算），
  // 第 6 轮给文本收尾 —— 让 messages 长度越过 keepHead+keepTail 门槛，
  // 从而真正走到 compactMessages 分支。
  //
  // 注意：摘要压缩本身也会发一次模型请求，必须按请求体区分，否则摘要
  // 调用会吃掉 mock 的轮次计数器，导致工具轮数对不上。
  let toolRounds = 0;
  globalThis.fetch = async (_u, init) => {
    let isSummaryCall = false;
    try {
      const body = JSON.parse(init?.body || '{}');
      isSummaryCall = (body.messages || []).some(
        (m) => typeof m.content === 'string' && m.content.includes('压缩为一份高密度纪要')
      );
    } catch { /* 非 JSON 请求按普通调用处理 */ }
    if (isSummaryCall) return sse([{ content: '【纪要】用户启动任务，已执行若干命令。' }]);
    toolRounds++;
    if (toolRounds <= 5) {
      return sse([{ tool_calls: [{ index: 0, id: 't' + toolRounds, function: { name: 'bash', arguments: JSON.stringify({ command: `head -c 3000 /dev/zero | tr '\\0' 'x'` }) } }] }]);
    }
    return sse([{ content: '收尾' }]);
  };
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock', maxTokensBudget: 1200 };
    const messages = [{ role: 'user', content: '开始' }];
    const events = [];
    for await (const ev of runAgent({ cfg, cwd: tmp, messages, permissionMode: 'bypass' })) events.push(ev);

    // 1) 超预算触发压缩事件，并携带前后 token 估算（供前端提示用）
    const comp = events.find((e) => e.type === 'compact');
    assert.ok(comp, '超预算应触发 compact 事件');
    assert.equal(typeof comp.tokensBefore, 'number');
    assert.equal(typeof comp.tokensAfter, 'number');
    assert.equal(typeof comp.budget, 'number');
    assert.ok(comp.compacted, '历史应被摘要压缩');
    assert.ok(comp.tokensAfter < comp.tokensBefore, `压缩后应更小 (${comp.tokensAfter} < ${comp.tokensBefore})`);

    // 2) 压缩后 messages 仍可安全持久化：首条是 system，正文不含被删的中段
    assert.equal(messages[0].role, 'system', 'system 提示词应保留在头部');
    assert.ok(messages.some((m) => typeof m.content === 'string' && m.content.includes('会话纪要')),
      '应插入一条会话纪要替代被压缩的早期历史');
    // 3) 收尾轮的结果仍然写入（压缩不影响后续追加）
    assert.equal(messages.at(-1).content, '收尾');
    // 4) 全程工具调用都被执行（5 次）
    assert.equal(events.filter((e) => e.type === 'tool-result').length, 5);
  } finally { globalThis.fetch = origFetch; }
});

await test('Agent 中止（abort）', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const messages = [{ role: 'user', content: 'x' }];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    let doneEv = null;
    for await (const ev of runAgent({ cfg, messages, signal: ac.signal, permissionMode: 'bypass' })) {
      if (ev.type === 'done') doneEv = ev;
    }
    assert.ok(doneEv, '应有 done 事件');
    assert.equal(doneEv.reason, 'aborted');
  } finally { globalThis.fetch = origFetch; }
});

console.log('--- 权限模式 5 档 ---');
// decidePermission 返回 {behavior, category, reason, suggestedRules}
const beh = (mode, tool, args, rules) => decidePermission(mode, tool, args, rules).behavior;

await test('工具名归一化：snake_case 与大小写写法等价', async () => {
  const { canonicalToolName, toolCategory } = await import(CORE + 'tools/builtin.js');
  assert.equal(canonicalToolName('read_file'), 'Read');
  assert.equal(canonicalToolName('Write'), 'Write');
  assert.equal(canonicalToolName('WRITE_FILE'), 'Write');
  assert.equal(canonicalToolName('web_fetch'), 'WebFetch');
  assert.equal(canonicalToolName('不存在的工具'), '不存在的工具');
  // 归一化后分类正确 —— 这是前端 7 个渲染器与改动统计能复活的前提
  assert.equal(toolCategory('read_file'), 'read');
  assert.equal(toolCategory('edit_file'), 'write');
  assert.equal(toolCategory('bash'), 'execute');
});

await test('未知权限模式安全回退：读可用，写入必须确认', () => {
  assert.equal(beh('typo-mode', 'Read', { path: 'a.txt' }), 'allow');
  assert.equal(beh('typo-mode', 'Write', { path: 'a.txt', content: 'x' }), 'ask');
  assert.equal(beh('typo-mode', 'Bash', { command: 'npm test' }), 'ask');
});

await test('bypass 全放行（含 execute）', () => {
  assert.equal(beh('bypass', 'read_file'), 'allow');
  assert.equal(beh('bypass', 'bash'), 'allow');
  assert.equal(beh('bypass', 'Write'), 'allow');
});

await test('default：只读自动放行，写入/执行必须询问（不再等价于 bypass）', () => {
  assert.equal(beh('default', 'Read', { path: 'a.txt' }), 'allow');
  assert.equal(beh('default', 'Glob', {}), 'allow');
  assert.equal(beh('default', 'Write', {}), 'ask');
  assert.equal(beh('default', 'Edit', {}), 'ask');
  assert.equal(beh('default', 'Bash', { command: 'rm -rf build' }), 'ask');
  // 只读 shell 命令免询问（否则每敲一个 ls 都要点确认，工具就废了）
  assert.equal(beh('default', 'Bash', { command: 'ls -la' }), 'allow');
  assert.equal(beh('default', 'Bash', { command: 'git status' }), 'allow');
  // 写文件重定向 / 命令替换仍不享受免询问（复合命令分段放行见下一用例）
  assert.equal(beh('default', 'Bash', { command: 'ls && rm -rf x' }), 'ask');
  assert.equal(beh('default', 'Bash', { command: 'cat a > b' }), 'ask');
  assert.equal(beh('default', 'Bash', { command: 'echo $(rm -rf x)' }), 'ask');
});

await test('只读 Bash 升级：复合命令分段放行 + 丢弃型重定向剥离（系统查询免确认）', () => {
  // 截图原始场景：macOS 系统信息查询复合命令，default 模式应直接放行
  assert.equal(beh('default', 'Bash', { command: 'defaults read -g AppleLanguages 2>/dev/null; sw_vers -productVersion' }), 'allow');
  // 复合命令每段独立过白名单，全段只读才放行
  assert.equal(beh('default', 'Bash', { command: 'pwd && date' }), 'allow');
  assert.equal(beh('default', 'Bash', { command: 'cat package.json | wc -l' }), 'allow');
  assert.equal(beh('default', 'Bash', { command: 'cat a | xargs rm' }), 'ask', '尾段含写命令不能放行');
  assert.equal(beh('default', 'Bash', { command: 'pwd; ls; date' }), 'allow');
  // 丢弃型重定向剥离；写真实文件仍拒绝
  assert.equal(beh('default', 'Bash', { command: 'ls -la 2>/dev/null' }), 'allow');
  assert.equal(beh('default', 'Bash', { command: 'ls > /dev/null' }), 'allow', '/dev/null 是丢弃不是写文件');
  assert.equal(beh('default', 'Bash', { command: 'echo hi > out.txt' }), 'ask', '写真实文件仍要确认');
  // macOS 系统查询：只读子命令放行，写子命令排除
  assert.equal(beh('default', 'Bash', { command: 'defaults read com.apple.dock' }), 'allow');
  assert.equal(beh('default', 'Bash', { command: 'defaults write com.apple.dock autohide -bool true' }), 'ask');
  assert.equal(beh('default', 'Bash', { command: 'sysctl -n hw.memsize' }), 'allow');
  assert.equal(beh('default', 'Bash', { command: 'sysctl -w kern.maxfiles=20480' }), 'ask');
  // 命令替换 / 前缀环境变量赋值不放行
  assert.equal(beh('default', 'Bash', { command: 'echo $(whoami)' }), 'ask');
  assert.equal(beh('default', 'Bash', { command: 'FOO=1 ls' }), 'ask');
  // 空段（如 ';;'）不放行
  assert.equal(beh('default', 'Bash', { command: 'ls;;' }), 'ask');
});

await test('accept_edits：只读+写入放行，执行仍询问', () => {
  assert.equal(beh('accept_edits', 'write_file'), 'allow');
  assert.equal(beh('accept_edits', 'edit_file'), 'allow');
  assert.equal(beh('accept_edits', 'read_file'), 'allow');
  assert.equal(beh('accept_edits', 'bash'), 'ask');
});

await test('explore：只读放行，写入/执行硬拒绝（不做任何修改是它的契约）', () => {
  assert.equal(beh('explore', 'read_file'), 'allow');
  assert.equal(beh('explore', 'glob'), 'allow');
  assert.equal(beh('explore', 'grep'), 'allow');
  assert.equal(beh('explore', 'write_file'), 'deny');
  assert.equal(beh('explore', 'edit_file'), 'deny');
  assert.equal(beh('explore', 'bash'), 'deny');
  // 即使有 allow 规则也不能让 explore 写盘
  assert.equal(beh('explore', 'Write', {}, [{ tool_name: 'Write', rule_content: '**', behavior: 'allow', source: 'userSettings' }]), 'deny');
});

await test('dont_ask：只读放行，其余直接拒绝（不打扰用户就等于不问）', () => {
  assert.equal(beh('dont_ask', 'read_file'), 'allow');
  assert.equal(beh('dont_ask', 'write_file'), 'deny');
  assert.equal(beh('dont_ask', 'bash'), 'deny');
  // ask 规则在 dont_ask 下退化为 deny，而不是静默放行
  assert.equal(beh('dont_ask', 'Write', {}, [{ tool_name: 'Write', rule_content: '**', behavior: 'ask', source: 'userSettings' }]), 'deny');
});

await test('允许清单：allow 规则命中即放行，deny 规则优先级最高（bypass 也拦得住）', () => {
  const allowNpm = [{ tool_name: 'Bash', rule_content: 'npm install', behavior: 'allow', source: 'userSettings' }];
  assert.equal(beh('default', 'Bash', { command: 'npm install express' }, allowNpm), 'allow');
  assert.equal(beh('default', 'Bash', { command: 'npm uninstall express' }, allowNpm), 'ask');

  const denyEnv = [{ tool_name: 'Read', rule_content: '**/.env', behavior: 'deny', source: 'userSettings' }];
  assert.equal(beh('bypass', 'Read', { path: '/w/.env' }, denyEnv), 'deny');
  assert.equal(beh('bypass', 'Read', { path: '/w/app.js' }, denyEnv), 'allow');
});

await test('suggestedRules：询问时顺带给出一份可一键固化的规则', () => {
  const d = decidePermission('default', 'Bash', { command: 'npm install express' });
  assert.equal(d.behavior, 'ask');
  assert.ok(d.suggestedRules.length >= 1, '应给出建议规则');
  assert.equal(d.suggestedRules[0].tool_name, 'Bash');
  assert.equal(d.suggestedRules[0].rule_content, 'npm install');
  assert.equal(d.suggestedRules[0].behavior, 'allow');

  const dw = decidePermission('default', 'Write', { path: 'src/a/b.ts' });
  assert.equal(dw.suggestedRules[0].tool_name, 'Write');

  // Browser：动作粒度太碎，建议"任意调用"（空 rule_content = 匹配全部动作）
  const db = decidePermission('default', 'Browser', { action: 'click', selector: '#go' });
  assert.equal(db.behavior, 'ask', 'default 下 click 属写类，应询问');
  const br = db.suggestedRules[0];
  assert.equal(br.tool_name, 'Browser');
  assert.equal(br.rule_content, '');
  assert.equal(br.behavior, 'allow');
  // 固化后应放行 Browser 的任意动作（包括读类 open）
  assert.equal(beh('default', 'Browser', { action: 'type', selector: 'input', text: 'x' }, [br]), 'allow');
  assert.equal(beh('default', 'Browser', { action: 'open', url: 'https://x.test' }, [br]), 'allow');
  // explore 的硬性只读契约不受放行规则影响
  assert.equal(beh('explore', 'Browser', { action: 'click', selector: '#go' }, [br]), 'deny');
  // 不给规则时：open（读）直接放行，click（写）仍要问
  assert.equal(beh('default', 'Browser', { action: 'open', url: 'https://x.test' }), 'allow');
  assert.equal(beh('default', 'Browser', { action: 'click', selector: '#go' }), 'ask');
});

await test('没有 ask 通道时，ask 降级为 deny 而不是静默放行', async () => {
  const origFetch = globalThis.fetch;
  let executed = false;
  globalThis.fetch = async () => {
    if (!executed) {
      executed = true;
      return sse([{ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Write', arguments: JSON.stringify({ path: 'nope.txt', content: 'x' }) } }] }]);
    }
    return sse([{ content: 'ok' }]);
  };
  try {
    const messages = [{ role: 'user', content: '写个文件' }];
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const events = [];
    for await (const e of runAgent({ cfg, cwd: tmp, messages, permissionMode: 'default' })) events.push(e);
    const tr = events.find((e) => e.type === 'tool-result');
    assert.ok(tr, '应有 tool-result; got ' + events.map((e) => e.type).join(','));
    assert.equal(tr.ok, false, '未经确认不得执行');
    assert.match(tr.result, /确认|权限/);
    assert.ok(!existsSync(join(tmp, 'nope.txt')), '文件不应被创建');
  } finally { globalThis.fetch = origFetch; }
});

await test('HITL：有 ask 通道时挂起等待用户答复，答复后才执行', async () => {
  const origFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      return sse([{ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Write', arguments: JSON.stringify({ path: 'hitl.txt', content: 'approved' }) } }] }]);
    }
    return sse([{ content: '已写入' }]);
  };
  try {
    const messages = [{ role: 'user', content: '写个文件' }];
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const events = [];
    const asked = [];
    const permissionAsk = async (req) => {
      asked.push(req);
      // 挂起期间文件必须还没写
      assert.ok(!existsSync(join(tmp, 'hitl.txt')), '用户还没答复就写盘了');
      return { confirmed: true, rules: [{ tool_name: 'Write', rule_content: '**', behavior: 'allow', source: 'userSettings' }] };
    };
    for await (const e of runAgent({ cfg, cwd: tmp, messages, permissionMode: 'default', permissionAsk })) events.push(e);
    assert.equal(asked.length, 1, '应询问一次');
    assert.equal(asked[0].name, 'Write');
    assert.equal(asked[0].category, 'write');
    const types = events.map((e) => e.type);
    assert.ok(types.includes('require-confirm'), '应发出 require-confirm 事件: ' + types.join(','));
    assert.ok(types.includes('confirm-resolved'));
    const tr = events.find((e) => e.type === 'tool-result');
    assert.equal(tr.ok, true, '确认后应执行: ' + tr.result);
    assert.equal(readFileSync(join(tmp, 'hitl.txt'), 'utf8'), 'approved');
    // 用户附加的规则被固化，后续同类调用不再问
    const added = events.find((e) => e.type === 'rule-added');
    assert.ok(added, '应发出 rule-added 事件');
  } finally { globalThis.fetch = origFetch; }
});

await test('AskUserQuestion：emit ask-user 事件 → 等通道答复 → 答案进 tool-result', async () => {
  const origFetch = globalThis.fetch;
  let call = 0;
  const questions = [{
    question: '这次想让我帮你做什么？',
    header: '意图',
    options: [
      { label: '编写新功能', description: '开发新功能' },
      { label: '修复 Bug', description: '排查并修复问题' }
    ]
  }];
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      return sse([{ tool_calls: [{ index: 0, id: 'ask_1', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ questions }) } }] }]);
    }
    return sse([{ content: '收到，开始修复 Bug' }]);
  };
  try {
    const messages = [{ role: 'user', content: '帮我干活' }];
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const events = [];
    const asked = [];
    const askUser = async (payload) => {
      asked.push(payload);
      assert.ok(typeof payload.emit === 'function', '通道应带 emit');
      assert.equal(payload.questions[0].question, '这次想让我帮你做什么？');
      // 与 bridge 的 askUser 同构：生成 id 并 emit ask-user 事件，再等答案
      payload.emit({ type: 'ask-user', id: 'ask_test_1', questions: payload.questions });
      return { answers: [{ selected: ['修复 Bug'], other: '' }], note: '' };
    };
    for await (const e of runAgent({ cfg, cwd: tmp, messages, permissionMode: 'bypass', askUser })) events.push(e);
    assert.equal(asked.length, 1, '应提问一次');
    const types = events.map((e) => e.type);
    assert.ok(types.includes('ask-user'), '应发出 ask-user 事件: ' + types.join(','));
    const au = events.find((e) => e.type === 'ask-user');
    assert.ok(au.id, 'ask-user 事件应带 id');
    assert.equal(au.questions[0].header, '意图');
    const tr = events.find((e) => e.type === 'tool-result' && e.name === 'AskUserQuestion');
    assert.equal(tr.ok, true);
    assert.match(tr.result, /修复 Bug/, '用户选择应回灌给模型');
    assert.ok(messages.some((m) => m.role === 'tool' && String(m.content).includes('修复 Bug')), 'tool 消息应含答案');
  } finally { globalThis.fetch = origFetch; }
});

await test('AskUserQuestion：无通道时返回兜底提示（不卡 run）', async () => {
  const origFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call++;
    if (call === 1) {
      return sse([{ tool_calls: [{ index: 0, id: 'ask_1', function: { name: 'AskUserQuestion', arguments: '{"questions":[{"question":"选哪个？","header":"方案","options":[{"label":"A","description":"a"},{"label":"B","description":"b"}]}]}' } }] }]);
    }
    return sse([{ content: '我自己判断' }]);
  };
  try {
    const messages = [{ role: 'user', content: '做选择' }];
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const events = [];
    for await (const e of runAgent({ cfg, cwd: tmp, messages, permissionMode: 'bypass' })) events.push(e);
    const tr = events.find((e) => e.type === 'tool-result' && e.name === 'AskUserQuestion');
    assert.equal(tr.ok, true, '兜底文案按成功返回（模型可读）');
    assert.match(tr.result, /没有用户交互通道/);
    assert.equal(events.at(-1).type, 'done');
  } finally { globalThis.fetch = origFetch; }
});

await test('runAgent explore 模式下 bash 被权限策略拒绝', async () => {
  const origFetch = globalThis.fetch;
  let callIdx = 0;
  globalThis.fetch = async () => {
    callIdx++;
    if (callIdx === 1) {
      return sse([{ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }]);
    }
    return sse([{ content: '已收到权限策略反馈' }]);
  };
  try {
    const messages = [{ role: 'user', content: 'ls' }];
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const events = [];
    for await (const e of runAgent({
      cfg,
      cwd: tmp,
      messages,
      permissionMode: 'explore',
    })) {
      events.push(e);
    }
    const toolRes = events.find((e) => e.type === 'tool-result');
    assert.ok(toolRes, '应有 tool-result 事件; got events: ' + events.map((e) => e.type).join(','));
    assert.equal(toolRes.ok, false);
    assert.match(toolRes.result, /权限策略拒绝/);
    assert.match(toolRes.result, /explore/);
  } finally { globalThis.fetch = origFetch; }
});

console.log('--- 安全基元（路径之外的另两条底线）---');
await test('子进程环境净化：密钥类变量被剥离，PATH/HOME 等保留', async () => {
  const { buildChildEnv } = await import(CORE + 'security.js');
  const { LEGACY_ENV_PREFIX } = await import(CORE + 'legacy-migration.js');
  const env = buildChildEnv({
    PATH: '/usr/bin', HOME: '/tmp', LANG: 'zh_CN.UTF-8',
    [`${LEGACY_ENV_PREFIX}_API_KEY`]: 'sk-x', COCODE_API_KEY: 'sk-y', MY_TOKEN: 't',
    AWS_SECRET_ACCESS_KEY: 's', DB_PASSWORD: 'p',
    NODE_OPTIONS: '--require=./evil.js'
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/tmp');
  assert.equal(env.LANG, 'zh_CN.UTF-8');
  for (const k of [`${LEGACY_ENV_PREFIX}_API_KEY`, 'COCODE_API_KEY', 'MY_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'NODE_OPTIONS']) {
    assert.ok(!(k in env), `${k} 不该出现在子进程环境里`);
  }
});

await test('脱敏：登记密钥 + 常见形态在出站文本里被替换', async () => {
  const { registerSecret, resetSecrets, redact } = await import(CORE + 'security.js');
  resetSecrets();
  registerSecret('sk-live-abcdef123456');
  assert.ok(!redact('key=sk-live-abcdef123456&x=1').includes('sk-live-abcdef123456'), '已登记的字面量应被替换');
  assert.ok(/Bearer/.test(redact('Authorization: Bearer abcdefghijklmnop')), 'Bearer 前缀保留');
  assert.ok(!redact('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'), 'Bearer 后的凭证应被遮掉');
  resetSecrets();
});

console.log('--- 项目指令 / ReAct 降级 / 持久 shell / 新工具 ---');
await test('项目指令：COCODE.md 注入 system prompt，自称与产品名统一为 CoCode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-prompt-'));
  writeFileSync(join(dir, 'COCODE.md'), '本项目规则：禁止使用 any 类型。');
  const origFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_u, init) => { captured = JSON.parse(init.body); return sse([{ content: 'ok' }]); };
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock', maxTurns: 1 };
    for await (const _ev of runAgent({ cfg, cwd: dir, messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
  } finally { globalThis.fetch = origFetch; }
  assert.ok(captured, 'fetch 未被调用');
  assert.equal(captured.messages[0].role, 'system');
  const sys = captured.messages[0].content;
  assert.match(sys, /禁止使用 any 类型/, 'COCODE.md 的内容应被注入 system prompt');
  assert.match(sys, /CoCode/, '提示词应统一为 CoCode');
  assert.ok(!/Corey/.test(sys), '不应再自称 Corey');
  rmSync(dir, { recursive: true, force: true });
});

await test('模型不支持 tool_calls → 自动降级为文本 ReAct 并继续干活', async () => {
  const origFetch = globalThis.fetch;
  const { resetToolSupportCache } = await import(CORE + 'model.js');
  resetToolSupportCache();
  let call = 0;
  let sawToolsAfterFallback = null;
  globalThis.fetch = async (_u, init) => {
    call++;
    if (call === 1) {
      // 模拟"不认识 tools 参数"的服务端
      return new Response(JSON.stringify({ error: { message: 'tools is not supported by this model' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }
    sawToolsAfterFallback = 'tools' in JSON.parse(init.body);
    if (call === 2) {
      // 降级后模型改用文本协议：fenced JSON 动作
      return sse([{ content: '我先列一下\n```json\n{"tool":"Glob","args":{"pattern":"a/*.txt"}}\n```' }]);
    }
    return sse([{ content: '看完了' }]);
  };
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock-no-tools', baseURL: 'http://mock-notools' };
    const events = [];
    for await (const e of runAgent({ cfg, cwd: tmp, messages: [{ role: 'user', content: '看看有哪些文件' }], permissionMode: 'bypass' })) events.push(e);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('mode-changed'), '应通知已降级: ' + types.join(','));
    assert.equal(events.find((e) => e.type === 'mode-changed').mode, 'react');
    assert.ok(types.includes('tool-result'), '降级后仍应真的执行工具: ' + types.join(','));
    assert.equal(sawToolsAfterFallback, false, '降级后不应再带 tools 参数');
  } finally {
    globalThis.fetch = origFetch;
    const { resetToolSupportCache: reset2 } = await import(CORE + 'model.js');
    reset2();
  }
});

await test('持久 shell：cd 与 export 跨调用保留（否则多步构建没法连写）', async () => {
  const sh = await bashTool.execute({ command: 'mkdir -p sub && cd sub', reset: true }, ctx);
  assert.match(sh, /exit_code: 0/);
  await bashTool.execute({ command: 'export COCODE_TEST_FOO=bar' }, ctx);
  const r = await bashTool.execute({ command: 'pwd; echo "FOO=$COCODE_TEST_FOO"' }, ctx);
  assert.match(r, /sub/, 'cd 应跨调用保留: ' + r);
  assert.match(r, /FOO=bar/, 'export 应跨调用保留: ' + r);
  // 输出里不该混进交互式提示符（oh-my-zsh / p10k 的噪声）
  assert.ok(!/❯|➜|%$/.test(r.trim()), 'shell 输出不该带提示符: ' + r);
});

await test('RepoMap：几百 token 给出符号骨架，不必反复 glob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-map-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  // 数据常量刻意不进骨架（否则骨架全是噪声、违背低 token 初衷），
  // 所以这里用箭头函数形式的常量来验证"模块级符号能被提取"
  writeFileSync(join(dir, 'src', 'a.js'), 'export function alpha() {}\nexport const beta = async (x) => x * 2;\nclass Gamma {}\n');
  writeFileSync(join(dir, 'src', 'b.py'), 'def delta():\n    pass\n');
  const { buildRepoMap } = await import(CORE + 'tools/repomap.js');
  const { text, symbols } = buildRepoMap(dir, { maxChars: 2000 });
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.match(text, /Gamma/);
  assert.match(text, /delta/);
  assert.ok(symbols >= 4, `符号数应 >=4，实际 ${symbols}`);
  assert.ok(!/function alpha\(\) \{\}/.test(text), '只给签名，不该带函数体');
  rmSync(dir, { recursive: true, force: true });
});

await test('WebFetch：拒绝 file:// 之外协议，HTML 转纯文本', async () => {
  const { webFetchTool, webSearchTool, setWebDnsLookup } = await import(CORE + 'tools/web.js');
  const bad = await webFetchTool.execute({ url: 'file:///etc/passwd' }, ctx);
  assert.match(bad, /已拒绝|http/);
  const origFetch = globalThis.fetch;
  setWebDnsLookup(async () => [{ address: '93.184.216.34' }]);
  globalThis.fetch = async () => new Response('<html><head><title>标题X</title></head><body><h1>T</h1><p>Hi &amp; more</p><script>var a=1;</script></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    const r = await webFetchTool.execute({ url: 'https://example.com/a' }, ctx);
    assert.match(r, /标题X/);
    assert.match(r, /Hi & more/);
    assert.ok(!/var a=1/.test(r), 'script 内容应被剥掉');
  } finally { globalThis.fetch = origFetch; setWebDnsLookup(null); }
  assert.ok(webSearchTool?.name === 'WebSearch');
});

await test('WebFetch：阻止内网、私网 DNS 与跳转 SSRF', async () => {
  const { webFetchTool, assertPublicHttpUrl, setWebFetcher, setWebDnsLookup } = await import(CORE + 'tools/web.js');
  await assert.rejects(() => assertPublicHttpUrl('http://127.1/admin'), /已拒绝/);
  await assert.rejects(() => assertPublicHttpUrl('http://[::1]/admin'), /已拒绝/);
  await assert.rejects(() => assertPublicHttpUrl('http://198.18.1.120/'), /已拒绝/);

  let calls = 0;
  setWebDnsLookup(async (host) => {
    if (host === 'private.example') return [{ address: '10.0.0.8' }];
    return [{ address: '93.184.216.34' }];
  });
  try {
    await assert.rejects(() => assertPublicHttpUrl('https://private.example/'), /已拒绝/);
    setWebFetcher(async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'manual', '重定向必须由 WebFetch 自行逐跳校验');
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:2375/containers/json' } });
    });
    const r = await webFetchTool.execute({ url: 'https://public.example/start' }, ctx);
    assert.match(r, /已拒绝/);
    assert.equal(calls, 1, '内网重定向目标不得发起第二次请求');
  } finally {
    setWebFetcher(null);
    setWebDnsLookup(null);
  }
});

await test('WebFetch：代理 Fake-IP 须经独立公网 DNS 校验，内网与校验失败仍拒绝', async () => {
  const { webFetchTool, setWebFetcher, setWebDnsLookup } = await import(CORE + 'tools/web.js');
  let targetCalls = 0;
  setWebDnsLookup(async () => [{ address: '198.18.1.120' }]);
  setWebFetcher(async (url, init) => {
    if (String(url).startsWith('https://cloudflare-dns.com/dns-query?')) {
      assert.equal(init.redirect, 'manual');
      const query = new URL(url);
      const host = query.searchParams.get('name');
      const type = query.searchParams.get('type');
      const address = host === 'private.example' ? '10.0.0.8' : '93.184.216.34';
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: address }] : [] });
    }
    targetCalls++;
    assert.equal(init.redirect, 'manual');
    if (String(url) === 'https://public.example/redirect') {
      return new Response(null, { status: 302, headers: { location: 'https://private.example/' } });
    }
    return new Response('<html><title>公网内容</title></html>', { headers: { 'content-type': 'text/html' } });
  });
  try {
    const publicResult = await webFetchTool.execute({ url: 'https://public.example/' }, ctx);
    assert.match(publicResult, /公网内容/);
    assert.equal(targetCalls, 1);
    const privateResult = await webFetchTool.execute({ url: 'https://private.example/' }, ctx);
    assert.match(privateResult, /已拒绝解析到本机、私网或保留 IP/);
    assert.equal(targetCalls, 1, '公网 DNS 回答为内网时不能请求目标');
    const redirected = await webFetchTool.execute({ url: 'https://public.example/redirect' }, ctx);
    assert.match(redirected, /已拒绝解析到本机、私网或保留 IP/);
    assert.equal(targetCalls, 2, '跳转到经 Fake-IP 伪装的私网域名时不得发起第二次请求');

    setWebFetcher(async (url) => {
      if (String(url).startsWith('https://cloudflare-dns.com/dns-query?')) throw new Error('DNS offline');
      targetCalls++;
      throw new Error('目标不应被请求');
    });
    const unverified = await webFetchTool.execute({ url: 'https://public.example/' }, ctx);
    assert.match(unverified, /无法独立核验.*安全中止/);
    assert.equal(targetCalls, 2, '独立 DNS 失败时必须保持关闭');
  } finally { setWebFetcher(null); setWebDnsLookup(null); }
});

await test('WebFetch：fetch failed 被翻译成可读原因（cause 链挖掘 + 错误码分类）', async () => {
  const { webFetchTool, setWebFetcher, setWebDnsLookup } = await import(CORE + 'tools/web.js');
  // 模拟 undici 的真实报错形态：表层 TypeError "fetch failed"，
  // 真正的原因（ENOTFOUND 等）藏在 e.cause 里。
  const cases = [
    [{ cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' } }, /域名无法解析/],
    [{ cause: { code: 'ECONNRESET', message: 'socket hang up' } }, /连接被目标站.*断开/],
    [{ cause: { code: 'EPROTO', message: 'wrong version' } }, /TLS 握手失败/],
    [{ cause: { code: 'ETIMEDOUT', message: 'connect timeout' } }, /连接超时/],
    [{ cause: { cause: { code: 'ECONNREFUSED', message: 'refused' } } }, /没有服务在监听/],
    [{ name: 'TimeoutError' }, /未响应/],
    [{ message: 'weird failure' }, /weird failure/], // 无错误码时透出原始 message
  ];
  setWebDnsLookup(async () => [{ address: '93.184.216.34' }]);
  try {
    for (const [thrown, pattern] of cases) {
      const err = Object.assign(new TypeError('fetch failed'), thrown);
      setWebFetcher(() => { throw err; });
      const r = await webFetchTool.execute({ url: 'https://example.com/' }, ctx);
      assert.match(r, pattern, `错误 ${JSON.stringify(thrown)} 应得到可读解释`);
      assert.ok(!/undefined/.test(r));
      setWebFetcher(null);
    }
  } finally { setWebFetcher(null); setWebDnsLookup(null); }
});

await test('WebFetch：注入的 fetcher 优先生效（桌面端走系统代理的通道）', async () => {
  const { webFetchTool, setWebFetcher, setWebDnsLookup } = await import(CORE + 'tools/web.js');
  let calledWith = null;
  setWebDnsLookup(async () => [{ address: '93.184.216.34' }]);
  setWebFetcher(async (url, init) => {
    calledWith = { url: String(url), ua: init?.headers?.['user-agent'] };
    return new Response('<html><title>注入通道</title></html>', {
      status: 200, headers: { 'content-type': 'text/html' }
    });
  });
  try {
    const r = await webFetchTool.execute({ url: 'https://example.com/inject' }, ctx);
    assert.match(r, /注入通道/);
    assert.equal(calledWith.url, 'https://example.com/inject');
    // UA 必须是真实浏览器形态（站点按 UA 拒绝非浏览器流量是 fetch failed 高发原因）
    assert.match(calledWith.ua, /Chrome\/126/);
  } finally { setWebFetcher(null); setWebDnsLookup(null); }
});

await test('Git 工具：拒绝白名单外子命令与破坏性 clean', async () => {
  const { gitTool, gitIsWrite } = await import(CORE + 'tools/git.js');
  const r1 = await gitTool.execute({ subcommand: 'push' }, ctx);
  assert.match(r1, /白名单|拒绝|不支持|exit_code/); // push 在白名单里但会因无远端失败，只要不抛异常
  const r2 = await gitTool.execute({ subcommand: 'clean', args: ['-fdx'] }, ctx);
  assert.match(r2, /已拒绝/);
  const r3 = await gitTool.execute({ subcommand: '; rm -rf /' }, ctx);
  assert.match(r3, /参数错误/);
  // 权限分类：读子命令 → read，写子命令 → write
  assert.equal(gitIsWrite('status'), false);
  assert.equal(gitIsWrite('commit'), true);
  assert.equal(gitIsWrite('branch', ['-a']), false);
  assert.equal(gitIsWrite('branch', ['-D', 'x']), true);
  assert.equal(gitIsWrite('config', ['--get', 'user.name']), false);
  assert.equal(gitIsWrite('config', ['user.name', 'x']), true);
});

console.log('--- HTTP 服务 ---');
await test('服务 API：config/sessions/chat(SSE)', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => sse([{ content: '好的' }]);
  const realFetch = origFetch;
  process.env.COCODE_API_KEY = 'test-key-for-server'; // 服务端 loadConfig 需要 key 才能进到模型调用
  try {
    const srv = await startServer({ port: 0 });
    const { port } = srv.address();
    const base = `http://127.0.0.1:${port}`;

    let r = await realFetch(base + '/api/config');
    assert.equal(r.status, 200);
    const cfg = await r.json();
    assert.ok('model' in cfg && 'baseURL' in cfg);

    r = await realFetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const session = await r.json();
    assert.ok(session.id);

    // 服务 API 测试同样要给会话设置 cwd，否则 runAgent 现在会拒绝运行
    await realFetch(base + `/api/sessions/${session.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmp })
    });

    // SSE 聊天
    r = await realFetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, content: '你好' })
    });
    assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const raw = await r.text();
    assert.match(raw, /"type":"start"/);
    assert.match(raw, /"type":"text-delta"/);
    assert.match(raw, /"type":"done"/);
    assert.match(raw, /"type":"session-saved"/);

    // 会话已持久化用户消息与回复
    r = await realFetch(base + `/api/sessions/${session.id}`);
    const s2 = await r.json();
    assert.equal(s2.messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(s2.messages.at(-1).role, 'assistant');

    // 无效路径
    r = await realFetch(base + '/api/nope');
    assert.equal(r.status, 404);

    await realFetch(base + `/api/sessions/${session.id}`, { method: 'DELETE' });
    srv.close();
  } finally { process.env.COCODE_API_KEY = ''; globalThis.fetch = origFetch; }
});


// ─────────────────────────── 代码导航与检索 ───────────────────────────

console.log('--- LSP（本地索引层）---');

const lsp = await import(CORE + 'tools/lsp.js');
const semantic = await import(CORE + 'tools/semantic.js');
const { loadHooks, runHooks, describeHooks, matcherMatches } = await import(CORE + 'hooks.js');
const { recentChanges } = await import(CORE + 'prompt.js');
const { COCODE_DIR } = await import(CORE + 'config.js');

await test('符号索引：函数/类/箭头常量都被提取，局部变量不算符号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-idx-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.js'), [
    'export function alpha(x) {',
    '  const local = x + 1;',   // 局部变量：不该进符号表
    '  return local;',
    '}',
    'export const beta = () => 1;',
    'class Gamma {}',
    'export type Delta = string;'
  ].join('\n'));
  const r = lsp.buildSymbolIndex(dir);
  const names = r.symbols.map((s) => s.name);
  assert.ok(names.includes('alpha'), 'alpha 应被索引: ' + names.join(','));
  assert.ok(names.includes('beta'), 'beta 应被索引');
  assert.ok(names.includes('Gamma'), 'Gamma 应被索引');
  assert.ok(names.includes('Delta'), 'Delta 应被索引');
  assert.ok(!names.includes('local'), '函数内局部变量不该成为符号');
  rmSync(dir, { recursive: true, force: true });
});

await test('跳定义 / 找引用：行号与文件都对得上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-idx2-'));
  writeFileSync(join(dir, 'lib.js'), 'export function target() {\n  return 1;\n}\n');
  writeFileSync(join(dir, 'use.js'), 'import { target } from \'./lib.js\';\n\nconst x = target();\n');
  const defs = lsp.findDefinition(dir, 'target');
  assert.equal(defs[0].file, 'lib.js');
  assert.equal(defs[0].line, 1);
  const refs = lsp.findReferences(dir, 'target');
  const files = refs.hits.map((h) => h.file);
  assert.ok(files.includes('use.js'), '引用应包含 use.js: ' + JSON.stringify(refs.hits));
  assert.ok(refs.hits.some((h) => h.line === 3), '应定位到第 3 行的调用');
  // 定义行本身不计入引用（它已在 definition 里给过）
  assert.ok(!refs.hits.some((h) => h.file === 'lib.js' && h.line === 1), '定义行不该重复出现在引用里');
  rmSync(dir, { recursive: true, force: true });
});

await test('诊断：真问题报，噪声不报（跨行模板字符串不产生括号误报）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-diag-'));
  writeFileSync(join(dir, 'bad.js'), [
    'export function f() {',
    '  try { risky(); } catch (e) {}',      // 空 catch
    '  debugger;',                            // debugger
    '  // TODO: 收拾一下',                    // todo
    '}',
    '<<<<<<< HEAD'                            // 合并冲突残留
  ].join('\n'));
  // 这个文件里有跨行模板字符串（反引号未配对出现在同一行上），不该报括号问题
  writeFileSync(join(dir, 'tpl.js'), 'export const q = `\n  {\n  }\n`;\nfunction ok() {}\n');
  const r = lsp.runDiagnostics(dir);
  const codes = r.items.map((d) => d.code);
  assert.ok(codes.includes('empty-catch'), '应报空 catch: ' + codes.join(','));
  assert.ok(codes.includes('debugger'), '应报 debugger');
  assert.ok(codes.includes('todo'), '应报 TODO');
  assert.ok(codes.includes('merge-conflict'), '应报合并冲突标记');
  assert.ok(!codes.includes('suspicious-brackets'), '不该对模板字符串误报括号');
  rmSync(dir, { recursive: true, force: true });
});

console.log('--- 语义检索（本地倒排）---');

await test('分词：camelCase / snake_case 拆开，中文按二字切', () => {
  const t1 = semantic.tokenize('findUserById');
  for (const w of ['finduserbyid', 'find', 'user', 'by', 'id']) assert.ok(t1.includes(w), `缺 ${w}`);
  const t2 = semantic.tokenize('失败重试');
  assert.ok(t2.includes('失败') && t2.includes('重试'), '中文应产出 bigram: ' + t2.join(','));
});

await test('检索：整词优先，命中定义行（搜 findUserById 时不该被 user 淹没）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-sem-'));
  writeFileSync(join(dir, 'a.js'), 'export function findUserById(id) {\n  return id;\n}\n');
  writeFileSync(join(dir, 'b.js'), 'const user = 1;\nconst users = [user];\nconst name = \'user\';\n');
  const r = semantic.searchIndex(dir, 'findUserById', { limit: 5 });
  assert.ok(r.hits.length > 0, '应有命中');
  assert.equal(r.hits[0].file, 'a.js');
  assert.equal(r.hits[0].line, 1);
  assert.equal(r.hits[0].definition, true, '定义行应被标记');
  rmSync(dir, { recursive: true, force: true });
});

await test('检索：中文能搜到中文注释', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-sem2-'));
  writeFileSync(join(dir, 'a.js'), '// 这里做失败重试，最多三次\nexport const n = 3;\n');
  const r = semantic.searchIndex(dir, '重试');
  assert.ok(r.hits.some((h) => h.file === 'a.js' && h.line === 1), '应命中中文注释行');
  rmSync(dir, { recursive: true, force: true });
});

await test('查询没命中时给出可操作的下一步（而不是一句"没有结果"）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-sem3-'));
  writeFileSync(join(dir, 'a.js'), 'export const x = 1;\n');
  const out = await semantic.searchTool.execute({ query: 'zzzz-not-there' }, { cwd: dir, sandboxRoots: [dir] });
  assert.match(out, /没有命中/);
  assert.match(out, /Grep/, '应提示改用 Grep');
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────── 钩子 ───────────────────────────

console.log('--- 钩子（生命周期）---');

await test('matcher：* / 联合 / 前缀通配都对', () => {
  assert.equal(matcherMatches('*', 'Bash'), true);
  assert.equal(matcherMatches('Bash|Write', 'Write'), true);
  assert.equal(matcherMatches('Bash|Write', 'Read'), false);
  assert.equal(matcherMatches('Ba*', 'Bash'), true);
  assert.equal(matcherMatches('bash', 'Bash'), false, '大小写敏感：与工具规范名一致才对');
});

await test('runHooks：钩子可以用 JSON 决策 deny，并能注入上下文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-hook-'));
  // 用 node 起一个小脚本当钩子：读 stdin 的 JSON，按 tool_name 决定
  writeFileSync(join(dir, 'guard.js'), `
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  if (input.tool_name === 'Bash') {
    console.log(JSON.stringify({ decision: 'deny', reason: '这个仓库不许跑命令' }));
  } else {
    console.log(JSON.stringify({ additionalContext: '当前是 ' + input.tool_name }));
  }
});
`);
  mkdirSync(join(COCODE_DIR), { recursive: true });
  writeFileSync(join(COCODE_DIR, 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" guard.js`, timeout: 10 }] }] }
  }));
  const cfg = { ...loadConfig(), trustProjectHooks: false };

  const denied = await runHooks('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, { cwd: dir, cfg });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /不许跑命令/);
  assert.equal(denied.ran, 1);

  const allowed = await runHooks('PreToolUse', { tool_name: 'Read', tool_input: { path: 'a' } }, { cwd: dir, cfg });
  assert.equal(allowed.decision, null, '没决策就是不影响');
  assert.match(allowed.additionalContext, /当前是 Read/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(COCODE_DIR, 'hooks.json'), { force: true });
});

await test('runHooks：钩子以退出码 2 阻断，stderr 作为原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-hook2-'));
  mkdirSync(join(COCODE_DIR), { recursive: true });
  writeFileSync(join(COCODE_DIR, 'hooks.json'), JSON.stringify({
    UserPromptSubmit: [{ command: 'echo "别问了" >&2; exit 2' }]
  }));
  const r = await runHooks('UserPromptSubmit', { prompt: '你好' }, { cwd: dir, cfg: loadConfig() });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /别问了/);
  rmSync(join(COCODE_DIR, 'hooks.json'), { force: true });
  rmSync(dir, { recursive: true, force: true });
});

await test('项目级钩子默认不执行（clone 一个仓库不该等于任意代码执行）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-hook3-'));
  mkdirSync(join(dir, '.cocode'), { recursive: true });
  // 这个钩子会创建文件；若不信任却执行了，文件就会存在 —— 是最直接的证据
  writeFileSync(join(dir, '.cocode', 'hooks.json'), JSON.stringify({
    PreToolUse: [{ command: 'touch ' + join(dir, 'PWNED') }]
  }));
  const cfg = loadConfig();
  const r = await runHooks('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, { cwd: dir, cfg });
  assert.equal(r.ran, 0, '未信任时不该跑');
  assert.ok(!existsSync(join(dir, 'PWNED')), '未信任的项目钩子绝不能被执行');
  assert.ok(r.notices.some((n) => /未信任/.test(n)), '应提示「检测到但未信任」: ' + JSON.stringify(r.notices));
  // 显式信任后才执行
  const r2 = await runHooks('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, { cwd: dir, cfg: { ...cfg, trustProjectHooks: true } });
  assert.equal(r2.ran, 1, '信任后应执行');
  rmSync(dir, { recursive: true, force: true });
});

await test('describeHooks：列出生效钩子与来源，坏 JSON 作为错误上报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-hook4-'));
  mkdirSync(join(COCODE_DIR), { recursive: true });
  writeFileSync(join(COCODE_DIR, 'hooks.json'), '{ 这不是 JSON');
  const d = describeHooks(dir, loadConfig());
  assert.ok(d.errors.some((e) => /JSON/.test(e)), '坏配置要能被看见: ' + JSON.stringify(d.errors));
  rmSync(join(COCODE_DIR, 'hooks.json'), { force: true });
  rmSync(dir, { recursive: true, force: true });
});

await test('Agent 循环：UserPromptSubmit 钩子 deny → 整轮被拦下且不进模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-hook5-'));
  mkdirSync(join(COCODE_DIR), { recursive: true });
  writeFileSync(join(COCODE_DIR, 'hooks.json'), JSON.stringify({
    UserPromptSubmit: [{ command: 'echo "{\\"decision\\":\\"deny\\",\\"reason\\":\\"今天不干活\\"}"' }]
  }));
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return sse([{ content: '不应该走到这里' }]); };
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const events = [];
    for await (const e of runAgent({
      cfg, cwd: dir, messages: [{ role: 'user', content: '你好' }], permissionMode: 'bypass'
    })) events.push(e);
    const done = events.find((e) => e.type === 'done');
    assert.equal(done.reason, 'blocked');
    assert.match(done.message, /今天不干活/);
    assert.equal(calls, 0, '被拦下的轮次不该请求模型');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(join(COCODE_DIR, 'hooks.json'), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('Agent 循环：PreToolUse 钩子 deny → 工具不执行，模型收到的是「钩子拒绝」而不是「工具坏了」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-hook6-'));
  mkdirSync(join(COCODE_DIR), { recursive: true });
  writeFileSync(join(COCODE_DIR, 'hooks.json'), JSON.stringify({
    PreToolUse: [{ matcher: 'Bash', command: 'echo "{\\"decision\\":\\"deny\\",\\"reason\\":\\"生产环境不能动\\"}"' }]
  }));
  const origFetch = globalThis.fetch;
  let callIdx = 0;
  globalThis.fetch = async () => {
    callIdx++;
    if (callIdx === 1) {
      return sse([{ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"command":"touch PWNED"}' } }] }]);
    }
    return sse([{ content: '收到' }]);
  };
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const events = [];
    for await (const e of runAgent({
      cfg, cwd: dir, messages: [{ role: 'user', content: '跑一下' }], permissionMode: 'bypass'
    })) events.push(e);
    const toolRes = events.find((e) => e.type === 'tool-result');
    assert.ok(toolRes, '应有 tool-result');
    assert.equal(toolRes.ok, false);
    assert.match(toolRes.result, /生产环境不能动/);
    assert.match(toolRes.result, /不要重试/, '要让模型知道这是硬规则');
    assert.ok(!existsSync(join(dir, 'PWNED')), '被钩子拒绝的命令绝不能真的执行');
  } finally {
    globalThis.fetch = origFetch;
    rmSync(join(COCODE_DIR, 'hooks.json'), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────── 变更感知上下文 ───────────────────────────

console.log('--- 变更感知上下文 ---');

await test('recentChanges：列出最近动过的文件，脏文件优先', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-chg-'));
  writeFileSync(join(dir, 'tracked.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'dirty.js'), 'export const b = 2;\n');
  const rows = recentChanges(dir, { dirty_files: ['dirty.js'] }, { limit: 5 });
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].file, 'dirty.js', '脏文件排最前');
  assert.equal(rows[0].dirty, true);
  assert.ok(rows.every((r) => typeof r.ago === 'string' && r.ago.length), '每个都要有人话时间');
  rmSync(dir, { recursive: true, force: true });
});

await test('系统提示词里出现「最近改动」段（模型才知道文件可能已经变了）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-chg2-'));
  writeFileSync(join(dir, 'recent.js'), 'export const x = 1;\n');
  const ctx = await loadProjectContext(dir, loadConfig());
  const p = buildSystemPrompt({ basePrompt: '你是 CoCode', projectContext: ctx });
  assert.match(p, /最近改动/);
  assert.match(p, /recent\.js/);
  rmSync(dir, { recursive: true, force: true });
});


// ─────────────────────────── Git 状态字段（前端渲染依赖） ───────────────────────────

console.log('--- Git 状态（字段完整性）---');

await test('readGitInfo 返回前端的 GitStatus 全部字段（少一个字段就会让界面崩）', async () => {
  const { readGitInfo } = await import(CORE + 'tools/git.js');
  const { execFileSync } = await import('node:child_process');
  // 环境守卫：git 不可用（如 Xcode 许可证未同意）时跳过，不把环境问题误报成代码回归
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
  catch { console.log('  ⏭ 跳过：系统 git 不可用（git --version 失败，检查 Xcode 许可证）'); return; }
  const d = mkdtempSync(join(tmpdir(), 'cocode-gitfields-'));
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });

  git('init', '-q');
  writeFileSync(join(d, 'a.txt'), 'l1\nl2\nl3\n');

  // 1) 空仓库：前端 GitStatus 的字段必须**全部存在**。
  //    之前后端少返回 insertions/head，前端 `formatNumber(git.insertions)`
  //    直接抛 "Cannot read properties of undefined (reading 'toLocaleString')" ——
  //    整棵渲染树被打崩，而这只是"一个角标没数字"。
  const r1 = await readGitInfo(d);
  for (const k of ['branch', 'head', 'ahead', 'behind', 'insertions', 'deletions',
    'staged', 'unstaged', 'untracked', 'conflicted']) {
    assert.ok(k in r1, `缺字段 ${k}：前端 GitStatus 会读到 undefined`);
  }
  assert.equal(typeof r1.insertions, 'number');
  assert.equal(typeof r1.deletions, 'number');
  // 空仓库没有 HEAD：null（"没有"）而不是 undefined（"没给"）
  assert.equal(r1.head, null);
  // 没配 upstream 时 ahead/behind 是 null（不知道），不是 0（一样多）
  assert.equal(r1.ahead, null);
  assert.equal(r1.untracked, 1);

  // 2) 提交 + 改动：统计要准
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  writeFileSync(join(d, 'a.txt'), 'l1\nl2 changed\nl3\nl4\nl5\n');
  const r2 = await readGitInfo(d);
  assert.match(r2.head, /^[0-9a-f]{4,}$/, 'head 应是短 SHA: ' + r2.head);
  assert.equal(r2.insertions, 3, '加了 2 行、改了 1 行 → +3');
  assert.equal(r2.deletions, 1);
  assert.equal(r2.unstaged, 1);

  rmSync(d, { recursive: true, force: true });
});

// ─────────────────────────── 真 LSP（装了 language server 才跑） ───────────────────────────

console.log('--- 真 LSP（stdio JSON-RPC）---');

const { execFileSync } = await import('node:child_process');

/** PATH + 几个高频安装位置里找可执行文件；找不到返回 null。 */
function findBin(cmd) {
  const home = process.env.HOME || '';
  const dirs = [
    ...(process.env.PATH || '').split(':').filter(Boolean),
    `${home}/.workbuddy/binaries/node/workspace/node_modules/.bin`,
    `${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'
  ];
  for (const d of dirs) {
    const full = join(d, cmd);
    try { if (statSync(full).isFile()) return full; } catch { /* 继续找 */ }
  }
  return null;
}

// typescript-language-server 必须在项目里找到 typescript（很多人项目里并没有装），
// 所以顺带找一个 tsserver.js 供 initializationOptions 用。
function findTsserver() {
  const home = process.env.HOME || '';
  for (const d of [
    `${home}/.workbuddy/binaries/node/workspace/node_modules/typescript/lib/tsserver.js`,
    '/opt/homebrew/lib/node_modules/typescript/lib/tsserver.js',
    '/usr/local/lib/node_modules/typescript/lib/tsserver.js'
  ]) {
    try { if (statSync(d).isFile()) return d; } catch { /* 继续找 */ }
  }
  return null;
}

const TS_LS = process.env.COCODE_TS_LS || findBin('typescript-language-server');
const TS_SERVER = process.env.COCODE_TSSERVER || findTsserver();

await test('LSP 不可用时：回退到本地索引，并把失败原因说清楚（不静默）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-lsp-fail-'));
  writeFileSync(join(dir, 'a.js'), 'export function broken() {}\n');
  const out = await lsp.lspTool.execute(
    { action: 'definition', name: 'broken', file: 'a.js' },
    { cwd: dir, sandboxRoots: [dir], cfg: { lspServers: { '.js': { command: '/nonexistent/definitely-not-a-server', args: [] } } } }
  );
  assert.match(out, /本地索引/, '应回退');
  assert.match(out, /真 LSP 不可用/, '必须说明为什么，否则用户会以为功能没做：' + out.slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
});

if (TS_LS && TS_SERVER) {
  await test('LSP：definition / references / hover 真的走 stdio JSON-RPC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cocode-lsp-live-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'node', strict: true },
      include: ['src']
    }));
    writeFileSync(join(dir, 'src', 'lib.ts'),
      'export function greet(name: string): string {\n  return \'hi \' + name;\n}\n');
    writeFileSync(join(dir, 'src', 'use.ts'),
      'import { greet } from \'./lib\';\n\nexport const a = greet(\'x\');\nexport const b = greet(\'y\');\n');

    const ctx = {
      cwd: dir, sandboxRoots: [dir],
      cfg: {
        lspServers: {
          '.ts': {
            command: TS_LS,
            args: ['--stdio'],
            // 项目里不装 typescript 是常态，靠初始化参数指路才不会让 server 直接退出
            initializationOptions: { tsserver: { path: TS_SERVER } }
          }
        }
      }
    };

    const def = await lsp.lspTool.execute({ action: 'definition', name: 'greet', file: 'src/use.ts' }, ctx);
    assert.match(def, /（LSP）/, '应走真 LSP: ' + def.slice(0, 200));
    assert.match(def, /src\/lib\.ts/, '要能指向源码声明处（import 绑定不算答案）');

    const refs = await lsp.lspTool.execute({ action: 'references', name: 'greet', file: 'src/use.ts' }, ctx);
    assert.match(refs, /（LSP/);
    assert.match(refs, /src\/use\.ts:3/, '应精确列出第 3 行的调用');
    assert.match(refs, /src\/use\.ts:4/);

    const hover = await lsp.lspTool.execute({ action: 'hover', name: 'greet', file: 'src/use.ts' }, ctx);
    assert.match(hover, /Hover（LSP）/);

    // 关掉配置 → 立刻回到本地索引（同一进程内切换，验证没有缓存串味）
    const off = await lsp.lspTool.execute(
      { action: 'definition', name: 'greet', file: 'src/use.ts' },
      { ...ctx, cfg: { lspServers: {} } }
    );
    assert.match(off, /本地索引/);

    lsp.disposeLspClients();
    rmSync(dir, { recursive: true, force: true });
  });
} else {
  console.log('  ⊘ 跳过真 LSP 用例：未找到 typescript-language-server 或 tsserver.js');
  console.log(`    （COCODE_TS_LS / COCODE_TSSERVER 可显式指定；当前 TS_LS=${TS_LS || 'null'}）`);
}


// ─────────────────────────── 内置浏览器（Browser 工具） ───────────────────────────

console.log('--- Browser 工具（驱动可注册）---');

const browserMod = await import(CORE + 'tools/browser.js');
// 命名空间导入：下面要断言工具名归一化与权限分类
const builtin = await import(CORE + 'tools/builtin.js');

await test('Browser：没有驱动时明确说清「没有内置浏览器」，不假装成功', async () => {
  browserMod.clearBrowserDriver();
  assert.equal(browserMod.hasBrowserDriver(), false);
  const out = await browserMod.browserTool.execute({ action: 'open', url: 'https://example.com' }, {});
  assert.match(out, /没有可用的内置浏览器/);
  assert.match(out, /WebFetch/, '要给出替代方案，而不是只说不行');
  // 关键：不能返回"已打开"之类的假成功 —— 模型会基于错误前提继续干活
  assert.ok(!/已打开/.test(out), '绝不能假装成功');
});

await test('Browser：注册驱动后按动作分发，并把结果整理成人话', async () => {
  const calls = [];
  browserMod.setBrowserDriver(async (action, params) => {
    calls.push([action, params]);
    if (action === 'open') return { url: params.url, title: '示例站点' };
    if (action === 'read') return { url: 'https://example.com/', title: '示例站点', text: '正文第一行\n正文第二行' };
    if (action === 'state') return { url: 'https://example.com/', title: '示例站点', loading: false, canGoBack: true, canGoForward: false };
    if (action === 'click') return { matched: 2 };
    if (action === 'type') return { matched: 1 };
    return { ok: true };
  });
  try {
    assert.ok(browserMod.hasBrowserDriver());

    const open = await browserMod.browserTool.execute({ action: 'open', url: 'example.com' }, {});
    assert.match(open, /已打开「示例站点」/);
    // 协议会被补全（与 WebFetch 同一套 assertHttpUrl）
    assert.equal(calls[0][1].url, 'https://example.com/');

    const read = await browserMod.browserTool.execute({ action: 'read' }, {});
    assert.match(read, /# 示例站点/);
    assert.match(read, /正文第一行/);

    const state = await browserMod.browserTool.execute({ action: 'state' }, {});
    assert.match(state, /可后退：是/);
    assert.match(state, /可前进：否/);

    const click = await browserMod.browserTool.execute({ action: 'click', selector: '#go' }, {});
    assert.match(click, /已点击 #go（匹配 2 个，点了第一个）/);

    const press = await browserMod.browserTool.execute({ action: 'press', key: 'Enter' }, {});
    assert.match(press, /已按下 Enter/);
  } finally {
    browserMod.clearBrowserDriver();
  }
});

await test('Browser：只允许 http/https，参数缺失有明确报错', async () => {
  browserMod.setBrowserDriver(async () => ({}));
  try {
    const file = await browserMod.browserTool.execute({ action: 'open', url: 'file:///etc/passwd' }, {});
    assert.match(file, /地址不合法|只允许 http\/https/);

    assert.match(await browserMod.browserTool.execute({ action: 'open' }, {}), /需要 url/);
    assert.match(await browserMod.browserTool.execute({ action: 'click' }, {}), /需要 selector/);
    assert.match(await browserMod.browserTool.execute({ action: 'press' }, {}), /需要 key/);
    // type 允许空字符串，但不允许"没给"
    assert.match(await browserMod.browserTool.execute({ action: 'type', selector: '#a' }, {}), /需要 text/);

    const bad = await browserMod.browserTool.execute({ action: 'teleport' }, {});
    assert.match(bad, /未知的 action/);
    assert.match(bad, /open/, '要列出可用动作');
  } finally {
    browserMod.clearBrowserDriver();
  }
});

await test('Browser：选择器没命中时给可操作的下一步，而不是一句"失败"', async () => {
  browserMod.setBrowserDriver(async (action) => (action === 'click' ? { matched: 0 } : {}));
  try {
    const click = await browserMod.browserTool.execute({ action: 'click', selector: '.nope' }, {});
    assert.match(click, /没有元素匹配/);
    assert.match(click, /read|state/, '要提示先看看当前页是不是预期那一页');
  } finally {
    browserMod.clearBrowserDriver();
  }
});

await test('Browser：驱动抛错时工具不抛出，而是回一段带排查方向的文本', async () => {
  browserMod.setBrowserDriver(async () => { throw new Error('页面拒绝被嵌入'); });
  try {
    const out = await browserMod.browserTool.execute({ action: 'open', url: 'https://blocked.example' }, {});
    assert.match(out, /浏览器操作失败（open）/);
    assert.match(out, /页面拒绝被嵌入/);
    assert.match(out, /WebFetch|state/, '失败信息要能指导下一步');
  } finally {
    browserMod.clearBrowserDriver();
  }
});

await test('Browser：驱动不返回（卡住）时按超时收口，不会把整轮拖死', async () => {
  browserMod.setBrowserDriver(() => new Promise(() => {})); // 永不 resolve
  try {
    const t0 = Date.now();
    const out = await browserMod.browserTool.execute({ action: 'read' }, { cfg: { browserTimeout: 1000 } });
    const spent = Date.now() - t0;
    assert.match(out, /超时/);
    assert.ok(spent < 4000, `应在超时附近返回，实际 ${spent}ms`);
  } finally {
    browserMod.clearBrowserDriver();
  }
});

await test('Browser：read 截断正文并说明还剩多少（低 token 纪律）', async () => {
  const long = 'x'.repeat(9000);
  browserMod.setBrowserDriver(async () => ({ url: 'https://e.com', title: 'T', text: long }));
  try {
    const out = await browserMod.browserTool.execute({ action: 'read' }, {});
    assert.ok(out.length < 7000, '默认应截断到 6000 字符附近，实际 ' + out.length);
    assert.match(out, /已截断到 6000/);
    assert.match(out, /共 9000 字符/);
    // 调大上限就不截断
    const bigger = await browserMod.browserTool.execute({ action: 'read', maxChars: 20000 }, {});
    assert.ok(bigger.length > 9000);
    assert.ok(!/已截断/.test(bigger));
  } finally {
    browserMod.clearBrowserDriver();
  }
});

await test('Browser：输入没真正写进去时要如实说（不能报「已输入」然后让模型去提交）', async () => {
  browserMod.setBrowserDriver(async (action) =>
    action === 'type' ? { matched: 1, applied: false } : {});
  try {
    const out = await browserMod.browserTool.execute({ action: 'type', selector: '#q', text: '你好' }, {});
    assert.match(out, /没有变成目标文本/, '要明确说值没落进去');
    assert.match(out, /富文本|程序化输入/, '要给出可能的原因');
    assert.match(out, /click|press/, '要给出下一步可试的做法');
    assert.ok(!/^已在/.test(out), '不能报成成功');
  } finally {
    browserMod.clearBrowserDriver();
  }
});

await test('Browser：screenshot 返回图像（多模态），坏数据要如实报错', async () => {
  browserMod.setBrowserDriver(async (action) =>
    action === 'screenshot'
      ? { data_url: 'data:image/png;base64,AAAA', url: 'https://e.com', title: '示例站点' }
      : {});
  try {
    const out = await browserMod.browserTool.execute({ action: 'screenshot' }, {});
    assert.ok(out && typeof out === 'object', '截图应返回 {text,image}');
    assert.equal(out.image.media_type, 'image/png');
    assert.match(out.image.data_url, /^data:image\/png;base64,/);
    assert.match(out.text, /已截取/);
  } finally {
    browserMod.clearBrowserDriver();
  }

  // 坏数据（空串/非图像）：不能静默当成功，模型会对着不存在的图继续推理
  browserMod.setBrowserDriver(async () => ({ data_url: '' }));
  try {
    const bad = await browserMod.browserTool.execute({ action: 'screenshot' }, {});
    assert.match(String(bad), /截图失败/, '空数据要如实报错');
    assert.ok(!(bad && typeof bad === 'object' && bad.image), '失败时不能带 image');
  } finally {
    browserMod.clearBrowserDriver();
  }
});

await test('Browser：导航算「读」、点击/输入算「写」（决定默认权限下要不要问）', () => {
  const { toolCategory } = builtin;
  assert.equal(toolCategory('Browser', { action: 'open' }), 'read');
  assert.equal(toolCategory('Browser', { action: 'read' }), 'read');
  assert.equal(toolCategory('Browser', { action: 'screenshot' }), 'read', '截图是只读动作');
  assert.equal(toolCategory('Browser', { action: 'back' }), 'read');
  assert.equal(toolCategory('Browser', { action: 'click' }), 'write');
  assert.equal(toolCategory('Browser', { action: 'type' }), 'write');
  assert.equal(toolCategory('Browser', { action: 'press' }), 'write');
});

await test('Browser：工具名归一化（browse / web_browser → Browser）', () => {
  assert.equal(builtin.canonicalToolName('browse'), 'Browser');
  assert.equal(builtin.canonicalToolName('web_browser'), 'Browser');
  assert.ok(builtin.builtinTools.some((t) => t.name === 'Browser'), '应出现在内置工具表里');
});

// ---------- 任务工具族（TaskCreate / TaskUpdate / TaskGet / TaskList） ----------
const tasksMod = await import(CORE + 'tools/tasks.js');

/** 内存版会话状态通道：模拟 bridge 接线（读 state、写合并） */
function fakeSessionState() {
  const state = {};
  return {
    state,
    read: () => state,
    write: (patch) => {
      Object.assign(state, structuredClone(patch));
    }
  };
}

await test('Task 工具族：创建/列表/详情/状态流转', async () => {
  const ss = fakeSessionState();
  const ctx = { sessionState: ss };

  const c1 = await tasksMod.taskCreate.execute({ subject: '修复登录超时', description: 'HTTP 401 在 60s 空闲后出现' }, ctx);
  assert.match(c1, /#T1/);
  const c2 = await tasksMod.taskCreate.execute({ subject: '补回归测试' }, ctx);
  assert.match(c2, /#T2/);

  const list = await tasksMod.taskList.execute({}, ctx);
  assert.match(list, /共 2 条（完成 0）/);
  assert.match(list, /\[pending\] 修复登录超时/);

  // 写入的是会话状态（state.tasks_context），前端计划面板读的就是它
  const tc = ss.state.tasks_context;
  assert.equal(tc.tasks.length, 2);
  assert.equal(tc.tasks[0].state, 'pending');

  await tasksMod.taskUpdate.execute({ taskId: 'T1', state: 'in_progress' }, ctx);
  const got = await tasksMod.taskGet.execute({ taskId: 'T1' }, ctx);
  assert.match(got, /\[in_progress\]/);
  assert.match(got, /HTTP 401/);

  await tasksMod.taskUpdate.execute({ taskId: 'T1', state: 'completed' }, ctx);
  const list2 = await tasksMod.taskList.execute({}, ctx);
  assert.match(list2, /完成 1/);
});

await test('Task 工具族：坏 id、非法状态、依赖环都给可操作的报错', async () => {
  const ss = fakeSessionState();
  const ctx = { sessionState: ss };
  await tasksMod.taskCreate.execute({ subject: 'A' }, ctx);
  await tasksMod.taskCreate.execute({ subject: 'B' }, ctx);

  const missing = await tasksMod.taskUpdate.execute({ taskId: 'T9', state: 'done' }, ctx);
  assert.match(missing, /没有任务 T9/);
  assert.match(missing, /现有：T1、T2/, '要列出可用的 id');

  const badState = await tasksMod.taskUpdate.execute({ taskId: 'T1', state: 'done' }, ctx);
  assert.match(badState, /非法状态/);

  await tasksMod.taskUpdate.execute({ taskId: 'T1', addBlockedBy: ['T2'] }, ctx);
  const cycle = await tasksMod.taskUpdate.execute({ taskId: 'T2', addBlockedBy: ['T1'] }, ctx);
  assert.match(cycle, /循环依赖/, 'A←B 且 B←A 会永远无法开工');

  const self = await tasksMod.taskUpdate.execute({ taskId: 'T1', addBlockedBy: ['T1'] }, ctx);
  assert.match(self, /自己/);
});

await test('Task 工具族：没有会话状态通道时如实说不可用（不假装成功）', async () => {
  const out = await tasksMod.taskCreate.execute({ subject: 'X' }, {});
  assert.match(out, /不可用/);
  assert.match(out, /会话状态通道/);
  const listed = await tasksMod.taskList.execute({}, {});
  assert.match(listed, /不可用/);
});

await test('Task 工具：权限分类与注册（Create/Update 是写，Get/List 是读）', () => {
  const { toolCategory, builtinTools } = builtin;
  assert.equal(toolCategory('TaskCreate', {}), 'write');
  assert.equal(toolCategory('TaskUpdate', { taskId: 'T1' }), 'write');
  assert.equal(toolCategory('TaskGet', { taskId: 'T1' }), 'read');
  assert.equal(toolCategory('TaskList', {}), 'read');
  for (const name of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']) {
    assert.ok(builtinTools.some((tl) => tl.name === name), `${name} 应注册进内置工具表`);
  }
});

// ---------- MCP stdio 客户端 ----------
const mcpMod = await import(CORE + 'tools/mcp.js');

/** 最小 MCP stdio 服务器：initialize / tools-list / tools-call(echo)。 */
function writeFakeMcpServer(dir) {
  const p = join(dir, 'fake-mcp.mjs');
  writeFileSync(p, `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id == null) continue;
    let result = {};
    if (msg.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0.0.1' } };
    } else if (msg.method === 'tools/list') {
      result = { tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
    } else if (msg.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg.params.arguments) }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`);
  return p;
}

await test('MCP：握手→列工具→调用 全链路（真实子进程）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cocode-mcp-'));
  const serverPath = writeFakeMcpServer(dir);
  const cfg = { mcpServers: { fake: { command: process.execPath, args: [serverPath] } } };
  try {
    const tools = await mcpMod.buildMcpTools(cfg);
    assert.equal(tools.length, 1, '应桥接出 1 个工具');
    assert.equal(tools[0].name, 'mcp__fake__echo');
    assert.match(tools[0].description, /^\[MCP:fake\]/);
    const out = await tools[0].execute({ text: '你好' }, { toolOutputLimit: 6000 });
    assert.equal(out, 'echo:{"text":"你好"}');

    // 状态探测：同一台服务器应报 ok 并带工具名
    const status = await mcpMod.mcpStatus(cfg);
    const ok = status.find((s) => s.name === 'fake');
    assert.equal(ok.status, 'ok');
    assert.deepEqual(ok.tools, ['echo']);
  } finally {
    mcpMod.stopAllMcpClients();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('MCP：服务器不存在时给占位工具 + 如实报错，不假装成功', async () => {
  const cfg = { mcpServers: { broken: { command: 'definitely-not-a-real-bin-xyz', args: [] } } };
  try {
    const tools = await mcpMod.buildMcpTools(cfg);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'mcp__broken__unavailable');
    const out = await tools[0].execute({}, {});
    assert.match(String(out), /不可用/);
    const status = await mcpMod.mcpStatus(cfg);
    assert.equal(status[0].status, 'error');
    assert.ok(status[0].error, '要带失败原因');
  } finally {
    mcpMod.stopAllMcpClients();
  }
});

await test('MCP：配置归一化剔除非法条目（空命令/危险键名）', () => {
  const norm = mcpMod.normalizeMcpServers({
    good: { command: 'npx', args: ['-y', 'x'] },
    'bad name': { command: 'x' },      // 键会进工具名，必须收紧
    nocmd: { args: [] },                // 没有 command
    empty: null
  });
  assert.deepEqual(Object.keys(norm), ['good']);
});

// ---------- Subagent（子代理） ----------
const subagentMod = await import(CORE + 'tools/subagent.js');

await test('Subagent：派生子运行并把最终结论带回来', async () => {
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_u, init) => {
    seen.push(JSON.parse(init.body));
    return sse([{ content: '调研结论：A 方案更优' }]);
  };
  try {
    const out = await subagentMod.subagentTool.execute(
      { name: '调研组', prompt: '比较 A 与 B 两个方案' },
      { cfg: { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock', maxTurns: 40 }, toolOutputLimit: 6000, permissionMode: 'default' }
    );
    assert.match(out, /「调研组」的结果/);
    assert.match(out, /A 方案更优/);
    assert.match(out, /子代理：0 次工具调用/);
    // 子代理有自己的独立上下文：发给模型的消息以任务书开头
    const childMsgs = seen[0].messages;
    assert.equal(childMsgs.at(-1).role, 'user');
    assert.match(childMsgs.at(-1).content, /比较 A 与 B/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('Subagent：权限只降不升（default 主会话 → explore 子代理），bypass 才跟随', async () => {
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    // 子代理第一轮：试图写文件（在 explore 下应被拒）；第二轮：总结
    if (bodies.length === 1) {
      return sse([{ tool_calls: [{ index: 0, id: 'w1', function: { name: 'Write', arguments: '{"path":"x.txt","content":"nope"}' } }] }]);
    }
    return sse([{ content: '写入被拒，改为只读结论' }]);
  };
  try {
    const out = await subagentMod.subagentTool.execute(
      { prompt: '写点东西' },
      { cfg: { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' }, permissionMode: 'default', toolOutputLimit: 6000 }
    );
    assert.match(out, /1 次被拒/, 'explore 下写操作应被拒');
    const childSystem = bodies[0].messages.find((m) => m.role === 'system')?.content ?? '';
    void childSystem;
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('Subagent：递归拦截与必填校验', async () => {
  const out = await subagentMod.subagentTool.execute({ prompt: 'x' }, { spawnDepth: 1 });
  assert.match(out, /不能再派生/);
  const noPrompt = await subagentMod.subagentTool.execute({}, {});
  assert.match(noPrompt, /prompt/);
});

await test('Subagent：主运行不注册 Subagent（防递归），子运行同样没有', () => {
  assert.ok(builtin.builtinTools.every((t) => t.name !== 'Subagent'), 'Subagent 不在 builtinTools（由 agent.js 按深度挂载）');
});

// ---------- Team worker 目录隔离 ----------
const teamMod = await import(CORE + 'tools/team.js');

await test('Team：可写 worker 默认 worktree，只有显式 shared 才允许共享写入目录', () => {
  assert.deepEqual(teamMod.resolveWorkerIsolation('explore', 'auto'), { ok: true, isolation: 'shared' });
  assert.deepEqual(teamMod.resolveWorkerIsolation('accept_edits', 'auto'), { ok: true, isolation: 'worktree' });
  assert.deepEqual(teamMod.resolveWorkerIsolation('bypass', 'auto'), { ok: true, isolation: 'worktree' });
  assert.deepEqual(teamMod.resolveWorkerIsolation('accept_edits', 'shared'), { ok: true, isolation: 'shared' });
  assert.deepEqual(teamMod.resolveWorkerIsolation('explore', 'worktree'), { ok: true, isolation: 'worktree' });
  assert.equal(teamMod.resolveWorkerIsolation('accept_edits', 'unsafe').ok, false);
});

// ---------- 深度思考（reasoning） ----------
await test('chatCompletion：reasoning_content/reasoning 走 onThinking，不混进正文', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"reasoning_content":"先想一步。"}}]}\n'
    + 'data: {"choices":[{"delta":{"reasoning":"再想一步。"}}]}\n'
    + 'data: {"choices":[{"delta":{"content":"结论 A"}}]}\n'
    + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const thinking = [];
  const texts = [];
  try {
    const { message } = await chatCompletion(
      { baseURL: 'http://x', apiKey: 'k', model: 'm' },
      { messages: [{ role: 'user', content: 'q' }], onDelta: (t) => texts.push(t), onThinking: (t) => thinking.push(t) },
    );
    assert.equal(message.content, '结论 A', '正文不含思考内容');
    assert.equal(thinking.join(''), '先想一步。再想一步。', '两种字段都进 onThinking');
    assert.equal(texts.join(''), '结论 A');
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('chatCompletion：思考参数被 400 拒时自动换挡重试并缓存档位', async () => {
  const origFetch = globalThis.fetch;
  const bodies = [];
  const sseOk = () => sse([{ content: 'ok' }]);
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response('{"error":{"message":"Unknown parameter: enable_thinking"}}', { status: 400 });
    }
    return sseOk();
  };
  const client = { baseURL: 'http://thinking-x', apiKey: 'k', model: 'm', thinking: true };
  try {
    const { message } = await chatCompletion(client, { messages: [{ role: 'user', content: 'q' }] });
    assert.equal(message.content, 'ok');
    assert.equal(bodies[0].enable_thinking, true, '第一档 enable_thinking');
    assert.equal(bodies[0].reasoning_effort, undefined);
    assert.equal(bodies[1].reasoning_effort, 'high', '被拒后换第二档 reasoning_effort');
    assert.equal(bodies[1].enable_thinking, undefined);
    // 换挡结果进缓存：同端点下一次请求直接用对的档位，不再撞 400
    await chatCompletion(client, { messages: [{ role: 'user', content: 'q' }] });
    assert.equal(bodies[2].reasoning_effort, 'high');
    assert.equal(bodies[2].enable_thinking, undefined, '命中缓存后不再发被拒的参数');
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('chatCompletion：未开深度思考时不带任何思考参数', async () => {
  const origFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return sse([{ content: 'ok' }]);
  };
  try {
    await chatCompletion({ baseURL: 'http://plain-x', apiKey: 'k', model: 'm' }, { messages: [{ role: 'user', content: 'q' }] });
    assert.equal(body.enable_thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('chatCompletion：thinkingEffort 决定 reasoning_effort 档位；未设置默认开', async () => {
  const origFetch = globalThis.fetch;
  const bodies = [];
  // enable_thinking 被拒 → 换到 reasoning_effort 档，此档才能观察到强度取值
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.enable_thinking) {
      return new Response('{"error":{"message":"Unknown parameter: enable_thinking"}}', { status: 400 });
    }
    return sse([{ content: 'ok' }]);
  };
  try {
    // 强度可调：low → reasoning_effort: low
    await chatCompletion(
      { baseURL: 'http://effort-x', apiKey: 'k', model: 'm', thinking: true, thinkingEffort: 'low' },
      { messages: [{ role: 'user', content: 'q' }] },
    );
    assert.equal(bodies[0].enable_thinking, true);
    assert.equal(bodies[1].reasoning_effort, 'low', '强度档应透传给 reasoning_effort');
    // createClient：未显式关闭时默认开启（parameters.thinking 缺省 = on）
    const { createClient } = await import(CORE + 'model.js');
    const c1 = createClient({ baseURL: 'http://x', apiKey: 'k', model: 'm' });
    assert.equal(c1.thinking, true, '默认开启');
    assert.equal(c1.thinkingEffort, 'high', '强度默认 high');
    const c2 = createClient({ baseURL: 'http://x', apiKey: 'k', model: 'm', thinking: false, thinkingEffort: 'low' });
    assert.equal(c2.thinking, false, '显式关闭才关');
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('chatCompletion：强制流式 —— 一律 stream:true，端点拒绝时报错而非降级', async () => {
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.stream) {
      return new Response('{"error":{"message":"stream mode is not supported by this model"}}', { status: 400 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '完整回答' } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { createClient } = await import(CORE + 'model.js');
    await assert.rejects(
      chatCompletion(
        { baseURL: 'http://nonstream-x', apiKey: 'k', model: 'm' },
        { messages: [{ role: 'user', content: 'q' }] },
      ),
      (e) => /stream mode is not supported/.test(e.message),
      '不支持流式的端点直接暴露错误，不自动降级',
    );
    // 即使 createClient 传 stream:false 也忽略：强制所有模型流式（thinking:false 让断言不受思考档位重试干扰）
    const client = createClient({ baseURL: 'http://nonstream-x', apiKey: 'k', model: 'm', stream: false, thinking: false });
    assert.equal(client.stream, undefined, 'createClient 不再有 stream 关闭位');
    await assert.rejects(
      chatCompletion(client, { messages: [{ role: 'user', content: 'q' }] }),
      /stream mode is not supported/,
    );
    assert.equal(bodies.length, 2, '两次请求都只发了一次（无降级重试）');
    assert.equal(bodies[0].stream, true, '始终流式');
    assert.ok(bodies[0].stream_options?.include_usage, '始终带 stream_options');
    assert.equal(bodies[1].stream, true, '第二次请求仍强制流式');
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('chatCompletion：端点对 stream:true 静默回 JSON 时按非流式解析', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '无视流式参数' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const { message } = await chatCompletion(
      { baseURL: 'http://silent-json-x', apiKey: 'k', model: 'm' },
      { messages: [{ role: 'user', content: 'q' }] },
    );
    assert.equal(message.content, '无视流式参数', '按 content-type 识别并走非流式解析');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------- 本地导入技能 ----------
await test('importSkillFromLocal：SKILL.md frontmatter 解析 + 重名拦截', async () => {
  const { importSkillFromLocal, listSkills } = await import(CORE + 'asapi/store.js');
  const dir = join(tmp, 'my-skill');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---
name: pdf-toolkit
display_name: PDF 工具箱
description: 处理 PDF 的技能
version: 1.2.0
---

# 用法说明
`);

  const view = importSkillFromLocal({ path: dir });
  assert.equal(view.name, 'pdf-toolkit');
  assert.equal(view.display_name, 'PDF 工具箱');
  assert.equal(view.version, '1.2.0');
  assert.equal(view.hub_id, 'local');
  const inList = listSkills().find((s) => s.id === view.id);
  assert.ok(inList, '应出现在技能库里');
  assert.equal(inList.description, '处理 PDF 的技能');

  // 再导一次 → name 冲突
  assert.throws(() => importSkillFromLocal({ path: dir }), (e) => e.code === 'NAME_CONFLICT');

  // 没有 SKILL.md 的目录 → 明确报错
  const emptyDir = join(tmp, 'not-a-skill');
  mkdirSync(emptyDir, { recursive: true });
  assert.throws(() => importSkillFromLocal({ path: emptyDir }), (e) => e.code === 'NO_SKILL_MD');
});

// ---------- asapi 存储/接口健壮性（Agent 不存在事故的回归） ----------
await test('asapi store：agents.json 损坏时隔离留证，不得静默当"首次使用"重建', async () => {
  const { listAgents, ASAPI_DIR } = await import(CORE + 'asapi/store.js');
  listAgents(); // 确保有一份正常文件
  const agentsPath = join(ASAPI_DIR, 'agents.json');
  writeFileSync(agentsPath, '{ 这不是 JSON'); // 模拟崩溃截断/损坏
  const agents = listAgents();
  // 服务可以重建默认 agent 继续跑，但损坏原件必须隔离留证（人工恢复的最后机会）
  assert.ok(Array.isArray(agents) && agents.length >= 1);
  const quarantined = readdirSync(ASAPI_DIR).filter((f) => f.startsWith('agents.json.corrupt-'));
  assert.ok(quarantined.length >= 1, '损坏文件应被改名为 agents.json.corrupt-*，而不是被默认 agent 直接覆盖');
});

await test('asapi API：用不存在的 agent_id 建会话 → 404，不产出死会话', async () => {
  const { startASAPIServer } = await import(CORE + 'asapi/server.js');
  const srv = await startASAPIServer({ port: 0 });
  const { port } = srv.address();
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/sessions/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_id: 'no-such-agent' })
  });
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.match(body.detail, /agent 不存在/);
  // 不能留下指向死 agent 的会话（那会让前端后续每条消息都 404）
  const rl = await fetch(base + '/sessions/');
  const { sessions } = await rl.json();
  assert.equal(sessions.filter((s) => s.agent_id === 'no-such-agent').length, 0);
  srv.close();
});

// ---------- Memory（存储 / 注入 / 路由 / 提炼） ----------
// memory.js 是独立入口（自带 COCODE_HOME 重定向 + fetch mock + process.exit），
// 用子进程聚合：隔离它对全局状态的改动，exit code 直接判定全绿与否。
{
  console.log('--- Memory（子进程聚合：存储/注入/路由/提炼）---');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const memoryRun = spawnSync(process.execPath, [fileURLToPath(new URL('./memory.js', import.meta.url))], { encoding: 'utf8' });
  if (memoryRun.stdout) process.stdout.write(memoryRun.stdout);
  if (memoryRun.stderr) process.stderr.write(memoryRun.stderr);
  await test('memory.js 全部用例通过（存储/注入/路由/提炼）', () => {
    assert.equal(memoryRun.status, 0, `memory.js 退出码 ${memoryRun.status}，应全绿`);
  });
}

// ---------- 内置终端（持久 shell + SSE 订阅 + 回放） ----------
console.log('--- 内置终端 ---');
await test('createTerminal/write/subscribe：回显、replay、exit 收口、幂等语义', async () => {
  const T = await import(CORE + 'asapi/terminal.js');
  const events = [];
  const info = T.createTerminal({ cwd: tmp, shell: '/bin/sh' });
  const unsub = T.subscribeTerminal(info.id, (e) => events.push(e));
  const waitFor = (pred, ms) => new Promise((r) => {
    const t0 = Date.now();
    const tick = () => (pred() ? r(true) : Date.now() - t0 > ms ? r(false) : setTimeout(tick, 40));
    tick();
  });

  assert.ok(T.writeTerminal(info.id, 'echo hi-mod-$((6*7))\r'), 'xterm Enter 的 CR 应被转换为 shell 换行');
  assert.ok(await waitFor(() => events.some((e) => e.type === 'data' && e.data.includes('hi-mod-42')), 8000),
    '订阅者应收到回显');
  assert.ok(T.replayTerminal(info.id).history.includes('hi-mod-42'), 'replay 应包含历史输出');
  assert.ok(T.writeTerminal(info.id, 'echo hi-tail\n'), '继续写入仍成功');

  // 环形回放上限：大量输出后 history 有界（200k 字符量级），不会无限膨胀
  assert.ok(T.writeTerminal(info.id, "head -c 400000 /dev/zero | tr '\\0' x\n"));
  await waitFor(() => events.some((e) => e.type === 'data' && e.data.length >= 65536), 8000);
  await new Promise((r) => setTimeout(r, 1200)); // 等输出推完
  const total = T.replayTerminal(info.id).history.length;
  assert.ok(total > 130_000 && total <= 210_000, `环形截断应把历史压到 200k 量级，实际 ${total}`);

  // 退出收口：kill → exit 事件 → 写/再杀均 false；未知 id 幂等安全
  assert.ok(T.killTerminal(info.id), 'kill 应成功');
  assert.ok(await waitFor(() => events.some((e) => e.type === 'exit'), 8000), '应收到 exit 事件');
  assert.equal(T.writeTerminal(info.id, 'echo x\n'), false, '已退出终端写不进去');
  assert.equal(T.writeTerminal(info.id, 42), false, '非字符串 data 拒绝');
  assert.equal(T.killTerminal(info.id), false, '重复 kill 幂等 false');
  assert.equal(T.getTerminal('nope'), null);
  assert.equal(T.subscribeTerminal('nope', () => {}), null);
  unsub();
});

await test('终端未选工作区时从主目录启动，Ctrl+C 中断命令后保留 shell', async () => {
  const { homedir } = await import('node:os');
  const { existsSync } = await import('node:fs');
  const shell = existsSync('/bin/zsh') ? '/bin/zsh' : existsSync('/bin/bash') ? '/bin/bash' : null;
  if (!shell || process.platform === 'win32') return;
  const T = await import(CORE + 'asapi/terminal.js');
  const info = T.createTerminal({ shell });
  const events = [];
  const unsub = T.subscribeTerminal(info.id, (event) => events.push(event));
  const waitFor = async (needle, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (events.some((event) => event.type === 'data' && event.data.includes(needle))) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  try {
    assert.equal(info.cwd, homedir());
    assert.ok(T.writeTerminal(info.id, 'echo INTERRUPT_READY; sleep 10\n'));
    assert.ok(await waitFor('INTERRUPT_READY'), '前台命令应已开始');
    assert.ok(T.interruptTerminal(info.id), 'Ctrl+C 应发送到整个终端进程组');
    assert.ok(T.writeTerminal(info.id, 'echo AFTER_INTERRUPT\n'));
    assert.ok(await waitFor('AFTER_INTERRUPT'), '中断后同一个 shell 应继续接受命令');
  } finally {
    unsub();
    T.killTerminal(info.id);
  }
});

console.log('\n--- Git 深度集成（分支/工作树/暂存/提交/日志）---');

await test('cocode-git：分支增删切 + 工作树增删 + 暂存/提交/日志 全链路', async () => {
  const G = await import(CORE + 'tools/cocode-git.js');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  // 环境守卫：git 不可用时跳过
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
  catch { console.log('  ⏭ 跳过：系统 git 不可用'); return; }

  const repo = mkdtempSync(join(tmpdir(), 'cocode-git-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'f.txt'), '1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  // 1) 分支列表：初始只有 main，且是当前分支
  let br = (await G.listBranches(repo));
  assert.ok(br.ok, 'listBranches 应成功');
  const names = br.branches.map((b) => b.name);
  assert.ok(names.includes('main'), '应有 main 分支');
  assert.ok(br.branches.find((b) => b.name === 'main')?.current, 'main 应是当前分支');

  // 2) 建分支 + 列表能看到
  assert.ok((await G.createBranch(repo, 'feat')).ok, 'createBranch feat');
  br = await G.listBranches(repo);
  assert.ok(br.branches.some((b) => b.name === 'feat'), 'feat 应出现在列表里');

  // 3) 切换分支
  assert.ok((await G.switchBranch(repo, 'feat')).ok, 'switchBranch feat');
  br = await G.listBranches(repo);
  assert.ok(br.branches.find((b) => b.name === 'feat')?.current, 'feat 应是当前');

  // 4) 工作树：在 repo 旁边建一个 wt，检出新分支 dev
  const wtPath = join(repo, '..', 'cocode-git-wt-dev');
  rmSync(wtPath, { recursive: true, force: true });
  const wt = await G.createWorktree(repo, wtPath, 'dev');
  assert.ok(wt.ok, 'createWorktree 应成功: ' + (wt.error || ''));
  const wts = await G.listWorktrees(repo);
  assert.ok(wts.ok);
  assert.ok(wts.worktrees.some((w) => w.branch === 'dev'), '应有 dev 工作树');

  // 5) 移除工作树
  assert.ok((await G.removeWorktree(repo, wtPath)).ok, 'removeWorktree');

  // 6) 暂存/取消暂存/提交/日志
  writeFileSync(join(repo, 'g.txt'), '2\n');
  let st = await G.statusFiles(repo);
  assert.ok(st.ok);
  assert.ok(st.untracked.includes('g.txt'), 'g.txt 应在 untracked');
  assert.ok((await G.stageFiles(repo, ['g.txt'])).ok, 'stage g.txt');
  st = await G.statusFiles(repo);
  assert.ok(st.staged.some((f) => f.path === 'g.txt'), 'g.txt 应在 staged');
  assert.ok((await G.unstageFiles(repo, ['g.txt'])).ok, 'unstage g.txt');
  st = await G.statusFiles(repo);
  assert.ok(!st.staged.some((f) => f.path === 'g.txt'), 'g.txt 应不在 staged');
  // 再暂存并提交
  assert.ok((await G.stageFiles(repo, [])).ok, 'stage -A');
  const cm = await G.commit(repo, 'add g');
  assert.ok(cm.ok, 'commit 应成功: ' + (cm.error || ''));
  const lg = await G.log(repo, 5);
  assert.ok(lg.ok);
  assert.ok(lg.commits.some((c) => c.subject === 'add g'), '日志应有 add g 提交');

  // 7) 安全删除分支：未合并提交应被保护，合并后才允许删除。
  assert.ok((await G.switchBranch(repo, 'main')).ok, 'switchBranch main');
  assert.equal((await G.deleteBranch(repo, 'feat')).ok, false, '未合并的 feat 不应被删除');
  git('merge', '--ff-only', 'feat');
  assert.ok((await G.deleteBranch(repo, 'feat')).ok, 'deleteBranch feat');

  rmSync(repo, { recursive: true, force: true });
  rmSync(wtPath, { recursive: true, force: true });
});

console.log('\n--- 检查点时间线（分支 + 当前位置）---');

await test('检查点时间线：snapshot 链 parent 正确；restore 后再快照形成分支，旧未来节点保留', async () => {
  const C = await import(CORE + 'tools/checkpoint.js');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const sid = 'test-timeline-' + Date.now();
  const d = mkdtempSync(join(tmpdir(), 'cocode-cp-'));

  // 1) 连续两次快照：节点 2 的 parent 应是节点 1
  writeFileSync(join(d, 'a.txt'), '1');
  const s1 = C.snapshot(d, { sessionId: sid, turn: 1 });
  assert.ok(s1.ok);
  assert.equal(s1.parent, null, '第一个节点 parent 为 null');
  writeFileSync(join(d, 'a.txt'), '2');
  const s2 = C.snapshot(d, { sessionId: sid, turn: 2 });
  assert.equal(s2.parent, s1.id, '第二个节点 parent 指向第一个');

  // 2) 回滚到节点 1：currentId 应变成 s1.id
  const r = C.restore(sid, s1.id, d);
  assert.ok(r.ok);
  assert.equal(C.getCurrentCheckpointId(sid), s1.id, '回滚后 currentId 指向节点 1');

  // 3) 再快照：新节点的 parent 应是 s1.id（形成分支），s2 仍存在
  writeFileSync(join(d, 'b.txt'), '3');
  const s3 = C.snapshot(d, { sessionId: sid, turn: 3 });
  assert.equal(s3.parent, s1.id, '回滚后新快照 parent 指向节点 1 → 分支');
  const list = C.listCheckpoints(sid);
  const ids = list.map((c) => c.id);
  assert.ok(ids.includes(s2.id), '旧的"未来"节点 2 仍保留，不被覆盖');
  assert.ok(ids.includes(s3.id), '新分支节点 3 存在');
  const cur = list.find((c) => c.current);
  assert.equal(cur?.id, s3.id, 'current 标记应在最新节点 3 上');

  C.clearCheckpoints(sid);
  rmSync(d, { recursive: true, force: true });
});

console.log('\n--- 事件触发自动化（规则 CRUD + notify 队列）---');

await test('automations：create/list/update/delete + notify 队列消费式读取', async () => {
  const A = await import(CORE + 'tools/automations.js');
  // 清场（用空数组覆盖，不删文件以免影响其它测试环境）
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { COCODE_DIR } = await import(CORE + 'config.js');
  const path = join(COCODE_DIR, 'automations.json');
  const backup = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path);

    // 1) create + list
    const r = A.createAutomation({ name: 'test-rule', event: 'Stop', actions: [{ type: 'notify', message: 'hi' }] });
    assert.ok(r.id, 'create 应返回带 id 的规则');
    assert.equal(r.event, 'Stop');
    const list = A.listAutomations();
    assert.ok(list.some((x) => x.id === r.id), 'list 应包含新规则');

    // 非法规则不得落盘；否则下一次 Agent 触发时才报错，定位成本会很高。
    const invalid = A.createAutomation({ name: 'bad', event: 'Stop', actions: [{ type: 'shell', command: 'echo bad' }] });
    assert.equal(invalid.ok, false);
    assert.equal(A.listAutomations().length, 1, '非法规则不应写入存储');

    // 2) update（enabled 关掉）
    const u = A.updateAutomation(r.id, { enabled: false });
    assert.equal(u.enabled, false);

    // 3) notify 队列：push + drain 消费式
    A.pushNotification('sess-1', 'hello');
    A.pushNotification('sess-1', 'world');
    const n = A.drainNotifications('sess-1');
    assert.equal(n.length, 2, '应收到 2 条通知');
    assert.equal(A.drainNotifications('sess-1').length, 0, 'drain 后队列清空');

    // 4) 命令自动化使用脱敏环境，非零退出码必须如实失败并通知，而非静默吞掉。
    process.env.COCODE_AUTOMATION_SECRET = 'do-not-leak';
    const commandRule = A.createAutomation({
      name: 'safe-command', event: 'Stop',
      actions: [{ type: 'command', command: 'test -z "$COCODE_AUTOMATION_SECRET"' }]
    });
    const safeRuns = await A.runAutomations('Stop', {}, { cwd: tmp, sessionId: 'sess-safe' });
    assert.ok(safeRuns.some((x) => x.rule_id === commandRule.id && x.ok), '密钥环境变量必须不传给自动化子进程');
    const failRule = A.createAutomation({ name: 'failed-command', event: 'Stop', actions: [{ type: 'command', command: 'exit 7' }] });
    const failedRuns = await A.runAutomations('Stop', {}, { cwd: tmp, sessionId: 'sess-fail' });
    assert.ok(failedRuns.some((x) => x.rule_id === failRule.id && x.ok === false && x.code === 7), '非零退出码不能伪装成功');
    assert.match(A.drainNotifications('sess-fail')[0]?.message || '', /failed-command.*命令失败/);
    delete process.env.COCODE_AUTOMATION_SECRET;

    // 5) delete
    A.deleteAutomation(r.id);
    A.deleteAutomation(commandRule.id);
    A.deleteAutomation(failRule.id);
    assert.equal(A.listAutomations().length, 0, 'delete 后列表为空');
  } finally {
    if (backup !== null) fs.writeFileSync(path, backup);
    else if (fs.existsSync(path)) fs.unlinkSync(path);
  }
});

console.log('\n--- 定时任务（cron + 时区 + 去重触发）---');

await test('schedules：cron 语义、时区换算与同一分钟恰好触发一次', async () => {
  const S = await import(CORE + 'asapi/schedules.js');
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { COCODE_DIR } = await import(CORE + 'config.js');
  const schedulesPath = join(COCODE_DIR, 'schedules.json');
  const runsPath = join(COCODE_DIR, 'schedule-runs.json');
  const backups = new Map([
    [schedulesPath, fs.existsSync(schedulesPath) ? fs.readFileSync(schedulesPath, 'utf8') : null],
    [runsPath, fs.existsSync(runsPath) ? fs.readFileSync(runsPath, 'utf8') : null],
  ]);
  try {
    // cron 的「日期 + 星期」均受限时取或，符合标准 cron；非法表达式绝不能入库。
    S.validateCron('*/15 8-18 * * 1-5');
    assert.throws(() => S.validateCron('61 * * * *'), /超出范围/);
    assert.equal(S.cronMatches('0 9 1 * 1', { minute: 0, hour: 9, day: 8, month: 1, dow: 1 }), true);
    assert.equal(S.cronMatches('0 9 1 * 1', { minute: 0, hour: 9, day: 8, month: 1, dow: 2 }), false);

    // 2026-01-01 00:00 UTC = 上海 08:00；非法时区要稳定回退 UTC。
    const now = new Date('2026-01-01T00:00:00.000Z');
    assert.deepEqual(
      S.tzParts(now, 'Asia/Shanghai'),
      { year: 2026, month: 1, day: 1, hour: 8, minute: 0, dow: 4 },
    );
    assert.equal(S.tzParts(now, 'not/a-timezone').hour, 0);

    for (const path of backups.keys()) if (fs.existsSync(path)) fs.unlinkSync(path);
    const schedule = S.createSchedule({
      name: '调度测试', agent_id: 'agent-test', timezone: 'UTC',
      cron_expression: '* * * * *', chat_model_config: { model: 'mock' },
    });
    let fired = 0;
    S.setScheduleFireHandler(async (record) => {
      fired++;
      assert.equal(record.id, schedule.id);
      return 'session-scheduled';
    });
    const first = await S.evaluateSchedules(now);
    const second = await S.evaluateSchedules(now);
    assert.equal(first.length, 1, '匹配分钟应触发一次');
    assert.equal(second.length, 0, '同一分钟重评估不得重复触发');
    assert.equal(fired, 1);
    assert.equal(S.listRuns(schedule.id)[0]?.session_id, 'session-scheduled');
    assert.throws(() => S.updateSchedule(schedule.id, { cron_expression: 'bad cron' }), /5 段/);
  } finally {
    S.setScheduleFireHandler(null);
    for (const [path, content] of backups) {
      if (content !== null) fs.writeFileSync(path, content);
      else if (fs.existsSync(path)) fs.unlinkSync(path);
    }
  }
});

console.log('\n--- MCP 工坊（服务器 CRUD + 模板）---');

await test('mcp-workshop：add/list/update/remove + 模板列表', async () => {
  const W = await import(CORE + 'tools/mcp-workshop.js');
  const fs = await import('node:fs');
  const { join } = await import('node:path');
  const { COCODE_DIR } = await import(CORE + 'config.js');
  const path = join(COCODE_DIR, 'config.json');
  const backup = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
  try {
    // 备份后清空 mcpServers
    const cfg = backup ? JSON.parse(backup) : {};
    delete cfg.mcpServers;
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2));

    // 1) 模板
    const tpls = W.listTemplates();
    assert.ok(Array.isArray(tpls) && tpls.length > 0, '应有预设模板');

    // 2) add
    const r = W.addServer('test-fetch', { command: 'npx', args: ['-y', 'mcp-server-fetch'] });
    assert.equal(r.name, 'test-fetch');
    const list = W.listServers();
    assert.ok(list.some((s) => s.name === 'test-fetch'), 'list 应包含新服务器');

    // 3) update（改 args）
    const u = W.updateServer('test-fetch', { args: ['-y', 'mcp-server-fetch@latest'] });
    assert.deepEqual(u.args, ['-y', 'mcp-server-fetch@latest']);

    // 4) 非法名称
    assert.throws(() => W.addServer('bad name!', { command: 'x' }), /字母/);

    // 5) remove
    W.removeServer('test-fetch');
    assert.equal(W.listServers().length, 0, 'remove 后列表为空');
  } finally {
    if (backup !== null) fs.writeFileSync(path, backup);
    else if (fs.existsSync(path)) fs.unlinkSync(path);
  }
});

await test('Agent 不再生成运行记录或交付报告目录', () => {
  assert.equal(existsSync(join(COCODE_DIR, 'traces')), false);
  assert.equal(existsSync(join(COCODE_DIR, 'deliveries')), false);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
