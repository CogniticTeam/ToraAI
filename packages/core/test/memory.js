// Memory 存储层测试：COCODE_HOME 重定向 / 读写 / 损坏隔离 / 去重合并 / 500 淘汰 / 评分排序 / 注入预算
// 运行：node packages/core/test/memory.js
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 数据根重定向到临时目录：测试绝不读写用户真实的 ~/.cocode。
// 必须在 import 任何 core 模块之前设置（动态 import 保证求值顺序，
// COCODE_DIR 在 config.js 模块顶层固化）。
process.env.COCODE_HOME = mkdtempSync(join(tmpdir(), 'cocode-memory-'));

const CORE = '../src/';
const {
  listMemories, saveMemory, updateMemory, deleteMemory, searchMemories,
  loadMemoryConfig, saveMemoryConfig, renderMemoryContext, MEMORY_GUIDE,
  MemoryValidationError, MEMORY_LIMIT, CONTENT_MAX, CONTEXT_BUDGET,
} = await import(CORE + 'asapi/memory.js');
const { COCODE_DIR } = await import(CORE + 'config.js');

const MEMORY_FILE = join(COCODE_DIR, 'asapi', 'memories.json');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('--- Memory 存储层 ---');

await test('初始状态：默认 config / 空库注入空串 / MEMORY_GUIDE 可用', async () => {
  assert.deepEqual(loadMemoryConfig(), { distill_enabled: false, inject_enabled: true });
  assert.equal(renderMemoryContext('/tmp'), '', '空库应返回空串、不加占位标题');
  assert.ok(MEMORY_GUIDE.includes('MemorySave') && MEMORY_GUIDE.includes('MemorySearch'));
});

await test('COCODE_HOME 重定向：文件落在临时目录，字段完整', async () => {
  const { memory, deduped } = saveMemory({ content: '回复用中文', kind: 'preference', source: 'manual' });
  assert.equal(deduped, false);
  assert.ok(memory.id && memory.created_at && memory.updated_at);
  assert.equal(memory.scope, 'global', '无 project_key 时 scope 缺省为 global');
  assert.equal(memory.project_key, '');
  assert.ok(existsSync(MEMORY_FILE) && MEMORY_FILE.includes('cocode-memory-'), 'memories.json 应写入 COCODE_HOME 下');
  const raw = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'));
  assert.equal(raw.memories.length, 1);
});

await test('scope 缺省按 project_key 推断，且做 realpath 归一', async () => {
  const { memory } = saveMemory({ content: '这个仓库跑测试是 node packages/core/test/run.js', project_key: '/tmp/nonexistent-proj-a' });
  assert.equal(memory.scope, 'project');
  assert.equal(memory.project_key, '/tmp/nonexistent-proj-a', '路径不存在时保留原值');
  assert.equal(memory.kind, 'fact', 'kind 缺省 fact');
  assert.equal(memory.source, 'tool', 'source 缺省 tool');
});

await test('去重合并：相似句更新而非新增（kind 以新值为准，pinned/source 保留）', async () => {
  const first = saveMemory({ content: '用户偏好深色主题界面' }).memory;
  updateMemory(first.id, { pinned: true });
  const r = saveMemory({ content: '用户 偏好 深色主题 界面', kind: 'preference', source: 'distill' });
  assert.equal(r.deduped, true, '归一化后相同的句子应判定为同一条');
  assert.equal(r.memory.id, first.id);
  assert.equal(r.memory.kind, 'preference', 'kind 以新值为准');
  assert.equal(r.memory.pinned, true, 'pinned 保留原值');
  assert.equal(r.memory.source, 'tool', 'source 保留原值');
  const dark = listMemories().filter((m) => m.content.includes('深色主题'));
  assert.equal(dark.length, 1, '不应新增条目');

  const r2 = saveMemory({ content: '用户偏好浅色主题的文档站点' });
  assert.equal(r2.deduped, false, '不同句应新增');
});

await test('参数校验：空/超长/非法枚举抛 MemoryValidationError 且不写入', async () => {
  const before = listMemories().length;
  assert.throws(() => saveMemory({ content: '   ' }), MemoryValidationError);
  assert.throws(() => saveMemory({ content: 'x'.repeat(CONTENT_MAX + 1) }), MemoryValidationError);
  assert.throws(() => saveMemory({ content: 'ok', kind: 'diary' }), MemoryValidationError);
  assert.throws(() => saveMemory({ content: 'ok', scope: 'agent' }), MemoryValidationError);
  assert.throws(() => saveMemory({ content: 'ok', source: 'magic' }), MemoryValidationError);
  assert.equal(listMemories().length, before, '校验失败不应写入');
});

await test('updateMemory / deleteMemory：改字段、id 不存在返回 null/false', async () => {
  const { memory } = saveMemory({ content: '待编辑的记忆条目' });
  const u = updateMemory(memory.id, { content: '编辑后的记忆条目', kind: 'pitfall', pinned: true });
  assert.equal(u.content, '编辑后的记忆条目');
  assert.equal(u.kind, 'pitfall');
  assert.equal(u.pinned, true);
  assert.throws(() => updateMemory(memory.id, { kind: 'bad' }), MemoryValidationError);
  assert.equal(deleteMemory(memory.id), true);
  assert.equal(deleteMemory(memory.id), false, '重复删除返回 false');
  assert.equal(updateMemory(memory.id, { pinned: false }), null, '已删除的 id 返回 null');
});

await test('评分排序：pinned 加权靠前、零命中不返回、limit 生效', async () => {
  const a = saveMemory({ content: '部署脚本在 deploy 目录下', project_key: '/tmp/proj-score' }).memory;
  saveMemory({ content: '部署前要跑 lint 检查', project_key: '/tmp/proj-score' });
  updateMemory(a.id, { pinned: true });
  const hits = searchMemories('部署');
  assert.equal(hits.length, 2, '两条都含"部署"应都命中');
  assert.equal(hits[0].id, a.id, '置顶加权应排第一');
  assert.equal(searchMemories('完全无关词xyzzy').length, 0, '零命中不返回');
  assert.equal(searchMemories('部署', { limit: 1 }).length, 1, 'limit 生效');
});

await test('时间衰减：同词命中时 updated_at 新的排前', async () => {
  const fresh = saveMemory({ content: '发布前要更新版本号' }).memory;
  const raw = JSON.parse(readFileSync(MEMORY_FILE, 'utf8'));
  raw.memories.push({
    id: 'stale-x', created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
    scope: 'global', project_key: '', kind: 'fact', source: 'tool', pinned: false, content: '发布流程要跑冒烟',
  });
  writeFileSync(MEMORY_FILE, JSON.stringify(raw));
  const hits = searchMemories('发布');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, fresh.id, '新的应排前（时间衰减加分）');
  assert.ok(hits.some((m) => m.id === 'stale-x'));
});

await test('500 条上限：最旧非置顶先淘汰，置顶豁免', async () => {
  const mk = (i, pinned = false) => {
    const t = `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`;
    return {
      id: `t-${i}`, created_at: t, updated_at: t,
      scope: 'global', project_key: '', kind: 'fact', source: 'tool', pinned, content: `白盒条目 ${i}`,
    };
  };
  // t-0 最旧且置顶；t-1..t-500 共 500 条非置顶 → 库内 501 条
  const list = [mk(0, true), ...Array.from({ length: MEMORY_LIMIT }, (_, i) => mk(i + 1))];
  writeFileSync(MEMORY_FILE, JSON.stringify({ memories: list }));
  saveMemory({ content: '触发淘汰的新条目' });
  const scoped = listMemories().filter((m) => m.scope === 'global');
  assert.equal(scoped.length, MEMORY_LIMIT, '501 条再加 1 条应淘汰 2 条最旧非置顶，回到上限');
  assert.ok(!scoped.some((m) => m.id === 't-1') && !scoped.some((m) => m.id === 't-2'), '最旧非置顶先淘汰');
  assert.ok(scoped.some((m) => m.id === 't-0'), '置顶条目应豁免');
  assert.ok(scoped.some((m) => m.content === '触发淘汰的新条目'));
});

await test('renderMemoryContext：分组顺序 置顶 > 项目 > 全局，预算截断', async () => {
  const long = (tag, n) => `内容标记${tag} ` + '字'.repeat(n);
  saveMemory({ content: long('PIN1', 1400), pinned: true });
  saveMemory({ content: long('PIN2', 1400), pinned: true });
  saveMemory({ content: long('PROJ', 1800), project_key: '/tmp/nonexistent-proj-render' });
  saveMemory({ content: long('GLOB', 1800) });
  const out = renderMemoryContext('/tmp/nonexistent-proj-render');
  assert.ok(out.startsWith('## 长期记忆'));
  assert.ok(out.includes('PIN1') && out.includes('PIN2'), '置顶条目应全部进入');
  assert.ok(out.length >= 4000 && out.length <= CONTEXT_BUDGET + 200, `输出 ${out.length} 字符应接近但不超预算 ${CONTEXT_BUDGET}`);
  assert.ok(!out.includes('GLOB'), '放不下的全局条目应被截断');
  const idxPinned = out.indexOf('PIN1');
  const idxProj = out.indexOf('PROJ');
  assert.ok(idxProj !== -1 && idxPinned < idxProj, 'project 条目应进入且排在置顶之后');
});

await test('损坏隔离：坏 JSON 隔离为 .corrupt-* 并自动重建', async () => {
  writeFileSync(MEMORY_FILE, '{ broken json !!');
  assert.deepEqual(listMemories(), [], '坏文件应走空 fallback');
  const corrupted = readdirSync(join(COCODE_DIR, 'asapi')).filter((f) => f.startsWith('memories.json.corrupt-'));
  assert.ok(corrupted.length >= 1, '应产生 .corrupt-* 隔离文件');
  saveMemory({ content: '损坏后重建的第一条' });
  assert.equal(listMemories().length, 1, '重建后可正常写入');
});

await test('memory-config 读写与损坏 fallback', async () => {
  saveMemoryConfig({ distill_enabled: true });
  assert.equal(loadMemoryConfig().distill_enabled, true);
  assert.equal(loadMemoryConfig().inject_enabled, true, '未指定字段保持原值');
  writeFileSync(join(COCODE_DIR, 'asapi', 'memory-config.json'), 'not json');
  assert.deepEqual(loadMemoryConfig(), { distill_enabled: false, inject_enabled: true }, '坏 config 走默认值');
});

console.log('--- Memory 工具层 ---');

await test('注册与归类：4 个工具进 builtinTools，toolCategory 全部 read', async () => {
  const { builtinTools, toolCategory } = await import(CORE + 'tools/builtin.js');
  const names = ['MemorySave', 'MemorySearch', 'MemoryList', 'MemoryForget'];
  for (const n of names) {
    assert.ok(builtinTools.some((t) => t.name === n), `${n} 应在 builtinTools 中`);
    assert.equal(toolCategory(n), 'read', `${n} 应归类 read（否则默认权限模式每次弹确认卡）`);
  }
});

await test('工具冒烟：save 推导 scope / 去重 / 校验转提示，search / list 过滤 / forget', async () => {
  const { memoryTools } = await import(CORE + 'tools/memory.js');
  const byName = (n) => memoryTools.find((t) => t.name === n);
  const save = byName('MemorySave'), search = byName('MemorySearch'),
    list = byName('MemoryList'), forget = byName('MemoryForget');
  const cwd = mkdtempSync(join(tmpdir(), 'cocode-memory-cwd-'));

  // 无 cwd → project_key 空 → 落 global
  const r1 = await save.execute({ content: '回复保持简洁风格', kind: 'preference' }, {});
  assert.ok(r1.includes('已存入全局记忆') && r1.includes('回复保持简洁风格'), r1);
  // 带 cwd → project_key = realpath(cwd) → 落 project
  const r2 = await save.execute({ content: '本项目用 pnpm', kind: 'convention' }, { cwd });
  assert.ok(r2.includes('已存入项目记忆') && r2.includes('本项目用 pnpm'), r2);
  // 相似内容（compact 后 bigram Jaccard 7/8 ≥ 0.85）→ 合并而非新增
  const r3 = await save.execute({ content: '回复保持简洁风格!' }, {});
  assert.ok(r3.includes('已合并更新（未新增条目）'), r3);
  // 校验失败转中文提示，不抛异常
  const r4 = await save.execute({ content: '   ' }, {});
  assert.ok(r4.startsWith('保存失败'), r4);

  const r5 = await search.execute({ query: '简洁' });
  assert.ok(r5.includes('回复保持简洁风格') && r5.startsWith('找到'), r5);
  const r6 = await search.execute({ query: '完全无关的词组不存在' });
  assert.ok(r6.startsWith('没有与'), r6);

  // list 缺省 = global + 当前 project，两条都在
  const r7 = await list.execute({}, { cwd });
  assert.ok(r7.includes('回复保持简洁风格') && r7.includes('本项目用 pnpm'), r7);
  // list scope=global 只显示 global
  const r8 = await list.execute({ scope: 'global' }, { cwd });
  assert.ok(r8.includes('回复保持简洁') && !r8.includes('本项目用 pnpm'), r8);

  const target = listMemories().find((m) => m.content.includes('pnpm'));
  const r9 = await forget.execute({ id: target.id });
  assert.ok(r9.includes('已删除'), r9);
  assert.equal(deleteMemory(target.id), false, '工具删除后存储层不应再有该 id');
  const r10 = await forget.execute({ id: 'no-such-id' });
  assert.ok(r10.startsWith('没有 id'), r10);
});

console.log('--- Memory 注入（agent 层）---');

// 与 test/run.js 同款 SSE mock：一轮文本即收尾，只关心捕获到的 system 提示
function sseOnce(chunks) {
  const events = chunks.map((c) => ({ choices: [{ delta: c }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  events.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const payload = 'data: ' + events.map((e) => JSON.stringify(e)).join('\ndata: ') + '\ndata: [DONE]\n\n';
  return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** mock fetch 跑一轮 runAgent，返回请求体里捕获到的 system 提示全文 */
async function captureSystem(cwd) {
  const { runAgent } = await import(CORE + 'agent.js');
  const { loadConfig } = await import(CORE + 'config.js');
  const origFetch = globalThis.fetch;
  let sys = null;
  globalThis.fetch = async (_u, init) => {
    if (!sys) {
      try { sys = JSON.parse(init?.body || '{}').messages.find((m) => m.role === 'system'); } catch { /* 非 JSON 请求忽略 */ }
    }
    return sseOnce([{ content: 'ok' }]);
  };
  try {
    const cfg = { ...loadConfig(), apiKey: 'test', model: 'mock', baseURL: 'http://mock' };
    const messages = [{ role: 'user', content: '验证记忆注入' }];
    for await (const _ of runAgent({ cfg, cwd, messages, permissionMode: 'bypass' })) { /* 只关心 system */ }
  } finally { globalThis.fetch = origFetch; }
  return sys?.content ?? '';
}

await test('runAgent 注入：system 提示含全局+项目记忆与使用指引', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cocode-inject-')));
  saveMemory({ content: '注入测试全局记忆条目' });
  saveMemory({ content: '注入测试项目记忆条目', project_key: cwd });
  const sys = await captureSystem(cwd);
  assert.ok(sys.includes('## 长期记忆'), '应含记忆区块标题');
  assert.ok(sys.includes('注入测试全局记忆条目') && sys.includes('注入测试项目记忆条目'), '全局与项目记忆都应注入');
  assert.ok(sys.includes('## 记忆使用指引'), '区块后应附使用指引');
});

await test('runAgent 注入：空库不加空区块；inject_enabled=false 整体关闭', async () => {
  // 空库：renderMemoryContext 返回空串 → composeSystem 走 base 分支，不加占位标题
  for (const m of listMemories()) deleteMemory(m.id);
  const sysEmpty = await captureSystem(realpathSync(mkdtempSync(join(tmpdir(), 'cocode-inject-empty-'))));
  assert.ok(!sysEmpty.includes('## 长期记忆'), '空库不应加记忆区块');

  // 开关关闭：即使库里有记忆也不注入（agent.js 动态读取 inject_enabled）
  saveMemoryConfig({ inject_enabled: false });
  saveMemory({ content: '关闭注入后仍存在的一条记忆' });
  const sysOff = await captureSystem(realpathSync(mkdtempSync(join(tmpdir(), 'cocode-inject-off-'))));
  assert.ok(!sysOff.includes('## 长期记忆') && !sysOff.includes('关闭注入后仍存在的一条记忆'), '关闭后不应出现记忆内容');
  saveMemoryConfig({ inject_enabled: true });
});

// ---------- HTTP API 层（server.js 路由 + API_PREFIXES） ----------
console.log('--- Memory HTTP API ---');
{
  const { startASAPIServer } = await import(CORE + 'asapi/server.js');
  const srv = await startASAPIServer({ port: 0 });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = async (path, opts) => {
    const r = await fetch(base + path, opts);
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 留 null 供「不应是 HTML」断言 */ }
    return { status: r.status, data, ct: r.headers.get('content-type') || '' };
  };
  const jsonPost = (path, body) => api(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const jsonPatch = (path, body) => api(path, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  const projCwd = realpathSync(mkdtempSync(join(tmpdir(), 'cocode-api-proj-')));
  for (const m of listMemories()) deleteMemory(m.id);

  await test('API：GET /memories 返回 JSON 而非 HTML（API_PREFIXES 生效）', async () => {
    const r = await api('/memories');
    assert.ok(r.ct.includes('application/json'), `content-type 应为 JSON，实际 ${r.ct}`);
    assert.deepEqual(r.data, { memories: [], total: 0 }, '清库后应返回空列表');
  });

  await test('API：POST /memories 创建 global/project 两条，source 强制 manual', async () => {
    const g = await jsonPost('/memories', { content: 'API 建的全局记忆', kind: 'preference' });
    assert.equal(g.status, 200);
    assert.equal(g.data.memory.source, 'manual', 'API 手动创建必须记 manual 来源');
    assert.equal(g.data.memory.scope, 'global', '无 project_key 时缺省 global');
    assert.equal(g.data.deduped, false);
    const p = await jsonPost('/memories', { content: 'API 建的项目记忆', scope: 'project', project_key: projCwd });
    assert.equal(p.data.memory.scope, 'project');
    assert.equal(p.data.memory.project_key, projCwd, 'project_key 应按 realpath 归一落盘');
  });

  await test('API：POST /memories 400 —— 非法 kind / 非法 scope / 空 content', async () => {
    assert.equal((await jsonPost('/memories', { content: 'x', kind: 'nope' })).status, 400);
    assert.equal((await jsonPost('/memories', { content: 'x', scope: 'galaxy' })).status, 400);
    assert.equal((await jsonPost('/memories', { content: '   ' })).status, 400);
    assert.equal((await jsonPost('/memories', {})).status, 400);
  });

  await test('API：GET /memories 过滤 scope/project_key（未归一路径也能匹配）', async () => {
    // /private/var/... 的 symlink 风格入参 /var/...：server 端归一后应匹配到存储值
    const unnormalized = projCwd.replace(/^\/private/, '');
    let r = await api(`/memories?scope=project&project_key=${encodeURIComponent(unnormalized)}`);
    assert.equal(r.data.total, 1, '未归一 project_key 应归一后匹配');
    assert.equal(r.data.memories[0].content, 'API 建的项目记忆');
    r = await api('/memories?scope=global');
    assert.equal(r.data.total, 1);
  });

  await test('API：GET /memories?q= 走评分检索', async () => {
    const r = await api(`/memories?q=${encodeURIComponent('项目记忆')}`);
    assert.ok(r.data.memories.some((m) => m.content === 'API 建的项目记忆'), '检索应命中项目记忆');
  });

  await test('API：PATCH /memories/:id 改 content/pinned；非法 kind 400；404 无此 id', async () => {
    const target = listMemories().find((m) => m.content === 'API 建的全局记忆');
    const r = await jsonPatch(`/memories/${target.id}`, { content: 'API 改过的全局记忆', pinned: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.memory.content, 'API 改过的全局记忆');
    assert.equal(r.data.memory.pinned, true);
    assert.equal((await jsonPatch(`/memories/${target.id}`, { kind: 'bad' })).status, 400);
    assert.equal((await jsonPatch('/memories/nonexistent-id', { content: 'x' })).status, 404);
  });

  await test('API：DELETE /memories/:id 成功后再删 404', async () => {
    const target = listMemories().find((m) => m.content === 'API 改过的全局记忆');
    assert.equal((await api(`/memories/${target.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api(`/memories/${target.id}`, { method: 'DELETE' })).status, 404);
    assert.ok(!listMemories().some((m) => m.id === target.id), '删除应真实落盘');
  });

  await test('API：GET/POST /memory-config 白名单读写；未匹配子路径 404 JSON 非 HTML', async () => {
    let r = await api('/memory-config');
    assert.deepEqual(r.data, { distill_enabled: false, inject_enabled: true });
    r = await jsonPost('/memory-config', { distill_enabled: true, inject_enabled: false, evil: '应被忽略' });
    assert.deepEqual(r.data, { distill_enabled: true, inject_enabled: false }, '只认白名单字段');
    await jsonPost('/memory-config', { distill_enabled: false, inject_enabled: true });
    const nf = await api('/memories/deadbeef');
    assert.equal(nf.status, 404);
    assert.ok(nf.ct.includes('application/json'), `未匹配路由应回 404 JSON，实际 ${nf.ct}`);
  });

  srv.close();
}

// ---------- 批次5：会话结束可选提炼（memory-distill.js，mock 模型 SSE） ----------
console.log('--- Memory 批次5：可选提炼 ---');
{
  const { distillFromRun, distillAfterRun, isDistillEnabled } = await import(CORE + 'asapi/memory-distill.js');
  const realFetch = globalThis.fetch;
  let calls = 0;
  let lastBody = null;
  const sseOf = (content) => {
    const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content } }], usage: {} })
      + '\ndata: ' + JSON.stringify({ choices: [], usage: {} }) + '\ndata: [DONE]\n\n';
    return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const cfg = { baseURL: 'http://127.0.0.1:9', apiKey: 'k', model: 'distill-test' };
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'cocode-distill-proj-')));

  await test('提炼：开关默认关闭，distillAfterRun 不发任何请求', async () => {
    assert.equal(isDistillEnabled(), false);
    globalThis.fetch = async () => { calls++; return sseOf('[]'); };
    await distillAfterRun(cfg, { userText: 'u', assistantText: 'a' });
    assert.equal(calls, 0, '关闭时不应触达模型');
  });

  // 打开开关跑后续用例（finally 恢复，避免污染其它用例的配置状态）
  saveMemoryConfig({ distill_enabled: true });
  try {
    await test('提炼：合法 JSON 数组 → 落盘 source=distill，project_key 归一入档', async () => {
      for (const m of listMemories()) deleteMemory(m.id);
      globalThis.fetch = async (u, init) => {
        calls++;
        lastBody = JSON.parse(init?.body || '{}');
        return sseOf('```json\n[{"content":"测试用 Vitest 跑","kind":"convention"},{"content":"用户偏好中文回复","kind":"preference"}]\n```');
      };
      calls = 0;
      const saved = await distillFromRun(cfg, {
        userText: '为什么测试一直红？'.slice(0, 2000), assistantText: '因为断言写错了', projectKey: proj
      });
      assert.equal(saved, 2);
      assert.equal(calls, 1);
      const userMsg = lastBody.messages.find((m) => m.role === 'user');
      assert.ok(userMsg.content.includes('为什么测试一直红'), '提示词应含截断后的用户文本');
      const items = listMemories().filter((m) => m.source === 'distill' && m.scope === 'project');
      assert.equal(items.length, 2);
      assert.ok(items.every((m) => m.project_key === proj), `project_key 应归一为 ${proj}`);
      assert.ok(items.some((m) => m.kind === 'convention') && items.some((m) => m.kind === 'preference'));
    });

    await test('提炼：无数组结构 → 0 条；有结构但 JSON 崩坏 → 静默 null，均不落盘', async () => {
      const before = listMemories().length;
      globalThis.fetch = async () => sseOf('这不是 JSON');
      assert.equal(await distillFromRun(cfg, { userText: 'u', assistantText: 'a' }), 0);
      globalThis.fetch = async () => sseOf('[broken] 不是合法 JSON');
      assert.equal(await distillFromRun(cfg, { userText: 'u', assistantText: 'a' }), null);
      assert.equal(listMemories().length, before);
    });

    await test('提炼：模型请求抛错 → 静默返回 null', async () => {
      globalThis.fetch = async () => { throw new Error('boom'); };
      assert.equal(await distillFromRun(cfg, { userText: 'u', assistantText: 'a' }), null);
    });

    await test('提炼：空产出 [] → 返回 0；非法 kind 被过滤只存合法条', async () => {
      globalThis.fetch = async () => sseOf('[]');
      assert.equal(await distillFromRun(cfg, { userText: 'u', assistantText: 'a' }), 0);
      globalThis.fetch = async () => sseOf('[{"content":"合法事实","kind":"fact"},{"content":"坏 kind","kind":"nope"}]');
      assert.equal(await distillFromRun(cfg, { userText: 'u', assistantText: 'a' }), 1);
      const facts = listMemories().filter((m) => m.kind === 'fact' && m.content === '合法事实');
      assert.equal(facts.length, 1);
    });

    await test('提炼：user/assistant 全空 → 不发请求直接返回 null', async () => {
      calls = 0;
      globalThis.fetch = async () => { calls++; return sseOf('[]'); };
      assert.equal(await distillFromRun(cfg, { userText: '   ', assistantText: '' }), null);
      assert.equal(calls, 0);
    });

    await test('提炼：全局记忆（无 projectKey）落 global scope', async () => {
      globalThis.fetch = async () => sseOf('[{"content":"全局偏好","kind":"preference"}]');
      assert.equal(await distillFromRun(cfg, { userText: 'u', assistantText: 'a' }), 1);
      const g = listMemories().filter((m) => m.scope === 'global' && m.content === '全局偏好');
      assert.equal(g.length, 1);
      assert.equal(g[0].source, 'distill');
    });
  } finally {
    globalThis.fetch = realFetch;
    saveMemoryConfig({ distill_enabled: false });
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
