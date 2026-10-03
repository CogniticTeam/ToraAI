import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const root = mkdtempSync(join(tmpdir(), 'tora-review-regression-'));
process.env.TORA_HOME = join(root, 'data');
process.env.TORA_API_KEY = 'fixture-global-key';
process.env.TORA_BASE_URL = 'https://fixture.invalid/v1';
process.env.SHELL = '/bin/bash';
const { loadExtraTools, resolveRunCfg } = await import('../src/asapi/bridge.js');
const { createCredential } = await import('../src/asapi/store.js');
const { saveConfig } = await import('../src/config.js');
const { createClient, chatCompletion } = await import('../src/model.js');
const { runAgent } = await import('../src/agent.js');
const { acquireShell, disposeAllShells, disposeOwnerShells } = await import('../src/tools/shell.js');
const { gitTool } = await import('../src/tools/git.js');
const { createToolRegistry } = await import('../src/tools/registry.js');
saveConfig({ hooksEnabled: false, injectProjectContext: false, repoMapInject: false, checkpointEnabled: false });
after(() => { disposeAllShells(); rmSync(root, { recursive: true, force: true }); });
const workspace = name => { const dir = join(root, name); mkdirSync(dir, { recursive: true }); return dir; };

test('项目工具必须单独信任，未信任模块顶层代码不能执行', async () => {
  const cwd = workspace('project'), marker = join(root, 'executed');
  mkdirSync(join(cwd, '.tora/tools'), { recursive: true });
  writeFileSync(join(cwd, '.tora/tools/probe.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes'); export default null;`);
  await loadExtraTools(cwd, { trustProjectHooks: true, permissionMode: 'bypass' });
  assert.equal(existsSync(marker), false);
  await loadExtraTools(cwd, { trustProjectToolsFor: [cwd] });
  assert.equal(existsSync(marker), true);
});

test('选择空 key 的凭证时不会把全局 key 发到新服务', async t => {
  const credential = createCredential({ type: 'openai_compatible', name: 'local', base_url: 'http://127.0.0.1:11434/v1', api_key: '' });
  const cfg = resolveRunCfg({ config: { chat_model_config: { credential_id: credential.id, model: 'local', parameters: { thinking: false } } } });
  assert.equal(cfg.apiKey, '');
  let outgoing;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    outgoing = init.headers;
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  });
  await chatCompletion(createClient(cfg), { messages: [{ role: 'user', content: 'test' }] });
  assert.ok(!JSON.stringify(outgoing).includes('fixture-global-key'));
});

test('交互 CLI 的首条和后续用户输入都送到模型', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fixture-complete' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [resolve('packages/cli/src/index.js')], {
    cwd: workspace('cli'), stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TERM: 'dumb', TORA_HOME: process.env.TORA_HOME, TORA_API_KEY: 'fixture',
      TORA_MODEL: 'fixture', TORA_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, SHELL: '/bin/bash' },
  });
  t.after(() => { child.kill('SIGKILL'); server.closeAllConnections(); server.close(); });
  child.stderr.resume();
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const wait = async predicate => {
    const deadline = Date.now() + 8000;
    while (!predicate()) { if (Date.now() > deadline) throw Error('CLI timeout'); await new Promise(r => setTimeout(r, 10)); }
  };
  child.stdin.write('TASK_ONE\n');
  await wait(() => output.includes('✓ 完成'));
  output = '';
  child.stdin.write('TASK_TWO\n');
  await wait(() => requests.length === 2);
  assert.equal(requests[0].messages.find(m => m.role === 'user').content, 'TASK_ONE');
  assert.deepEqual(requests[1].messages.filter(m => m.role === 'user').map(m => m.content), ['TASK_ONE', 'TASK_TWO']);
});

test('同一 shell 的并发调用排队，不混合输出；不同 owner 相互隔离', async () => {
  const cwd = workspace('shell');
  const a = acquireShell(cwd, {}, 'A'), b = acquireShell(cwd, {}, 'B');
  assert.notEqual(a, b);
  const ac = new AbortController();
  const [first, second] = await Promise.all([a.run('sleep 0.1; printf FIRST', 3000, ac.signal), a.run('printf SECOND', 3000)]);
  assert.equal(first.output.trim(), 'FIRST'); assert.equal(second.output.trim(), 'SECOND');
  const next = a.run('sleep 0.1; printf NEXT', 3000);
  ac.abort(); // Completed request's listener must no longer cancel another command.
  assert.equal((await next).exitCode, 0);
  const independent = b.run('sleep 0.1; printf INDEPENDENT', 3000);
  disposeOwnerShells('A');
  assert.equal((await independent).output.trim(), 'INDEPENDENT');
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await b.run('touch should-not-exist', 3000, stopped.signal)).aborted, true);
  assert.equal(existsSync(join(cwd, 'should-not-exist')), false);
});

test('获准 Git 写操作可写元数据；Git 非零退出报告失败；Bash 仍不可改 .git', { skip: process.platform !== 'darwin' }, async () => {
  const cwd = workspace('git'); execFileSync('git', ['init', '--quiet'], { cwd });
  writeFileSync(join(cwd, 'file.txt'), 'fixture');
  const ctx = { cwd, permissionMode: 'default', sandboxRoots: [cwd], shellSandbox: true };
  const registry = createToolRegistry([gitTool], name => name);
  const call = { function: { name: 'Git' } };
  const added = await registry.invoke(call, { subcommand: 'add', args: ['file.txt'] }, ctx);
  assert.equal(added.ok, true, added.result);
  assert.match(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' }), /file.txt/);
  const bad = await registry.invoke(call, { subcommand: 'add', args: ['missing.txt'] }, ctx);
  assert.equal(bad.ok, false);
  const shell = acquireShell(cwd, { enabled: true, roots: [cwd] }, 'restricted');
  assert.notEqual((await shell.run('touch .git/should-not-exist', 3000)).exitCode, 0);
  assert.equal(existsSync(join(cwd, '.git/should-not-exist')), false);
});

test('官方长对话压缩只发一次正式请求，不预先结束消息或多扣聊天次数', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { role: 'assistant', content: '正式回答' } }] });
  });
  for (const mode of ['chat', 'work']) {
    const before = requests.length;
    const events = [];
    for await (const e of runAgent({ cfg: { appMode: 'tochat', tochatMode: mode, provider: 'tochat-official',
      tochatMessageId: `reply-${mode}`, baseURL: 'https://fixture.invalid/tochat/v1', apiKey: 'fixture', model: 'deepseek-flash',
      hooksEnabled: false, injectProjectContext: false, repoMapInject: false, review: { enabled: false } },
      messages: Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(12000) })) })) events.push(e);
    assert.ok(events.some(e => e.type === 'compact' && e.compacted));
    assert.equal(requests.length - before, 1);
    assert.equal(events.at(-1).reason, 'completed');
    assert.ok(requests.at(-1).messages.some(m => String(m.content).includes('本地上下文摘录')));
  }
});
