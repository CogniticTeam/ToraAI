import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'tora-harness-mcp-'));
const previousHome = process.env.TORA_HOME;
process.env.TORA_HOME = testHome;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSpawn = childProcess.spawn;
const children = [];
mock.method(childProcess, 'spawn', (...args) => {
  const proc = nativeSpawn(...args);
  children.push({ proc, closed: new Promise((resolve) => proc.once('close', resolve)) });
  return proc;
});
syncBuiltinESMExports();

const { buildMcpTools, stopAllMcpClients, stopMcpClient } = await import('../src/tools/mcp.js');
const { createToolRegistry } = await import('../src/tools/registry.js');

after(async () => {
  stopAllMcpClients();
  for (const { proc } of children) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  }
  await Promise.all(children.map(({ closed }) => closed));
  mock.restoreAll();
  syncBuiltinESMExports();
  if (previousHome === undefined) delete process.env.TORA_HOME;
  else process.env.TORA_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

// Executed only by process.execPath -e: no config, files, packages or network.
function fakeServer(options) {
  const { createInterface } = require('node:readline');
  const calls = [];
  const cancelled = [];
  const waiting = new Map();
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const reply = (id, result) => send({ id, result });
  const text = (value) => ({ content: [{ type: 'text', text: value }] });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'notifications/cancelled') {
      cancelled.push(message.params);
      waiting.delete(message.params.requestId);
      // A late response must not resurrect the cancelled request or affect its peer.
      reply(message.params.requestId, text('late cancelled response'));
      return;
    }
    if (message.id == null) return;
    if (message.method === 'initialize') {
      if (options.exitOnInitialize) process.exit(9);
      const initialize = () => reply(message.id, {
        protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' }
      });
      if (options.initializeDelayMs) setTimeout(initialize, options.initializeDelayMs);
      else initialize();
      return;
    }
    if (message.method === 'tools/list') {
      reply(message.id, { tools: [{ name: 'probe', inputSchema: { type: 'object', properties: {} } }] });
      return;
    }
    if (message.method !== 'tools/call') return;
    const args = message.params.arguments;
    if (args.op === 'stats') {
      reply(message.id, text(JSON.stringify({ pid: process.pid, calls, cancelled })));
      return;
    }
    calls.push({ id: message.id, op: args.op, label: args.label });
    if (args.op === 'wait') {
      waiting.set(message.id, args.label);
    } else if (args.op === 'release') {
      for (const [id, label] of waiting) {
        if (label === args.label) {
          waiting.delete(id);
          reply(id, text('completed:' + label));
        }
      }
      reply(message.id, text('released'));
    } else if (args.op === 'rpc-error') {
      send({ id: message.id, error: { code: -32603, message: 'fixture remote failure' } });
    } else if (args.op === 'exit') {
      process.exit(7);
    } else {
      reply(message.id, args.result ?? text('ok'));
    }
  });
}

let serverNumber = 0;
function serverConfig(t, options = {}) {
  const name = `harness_${++serverNumber}`;
  t.after(() => stopMcpClient(name));
  return {
    name,
    cfg: { mcpServers: { [name]: {
      command: process.execPath,
      args: ['-e', `(${fakeServer.toString()})(${JSON.stringify(options)})`],
      env: { TORA_HOME: testHome, HOME: testHome }
    } } }
  };
}

async function fixture(t, options) {
  const { cfg, name } = serverConfig(t, options);
  const tools = await buildMcpTools(cfg, { timeoutMs: 2000 });
  assert.equal(tools.length, 1);
  const registry = createToolRegistry(tools, (value) => value);
  const invoke = (args, context = {}) => registry.invoke(
    { function: { name: tools[0].name } }, args, { cwd: testHome, ...context }
  );
  return {
    cfg, name, tools, invoke,
    async stats() {
      const result = await invoke({ op: 'stats' });
      assert.equal(result.ok, true);
      return JSON.parse(result.result);
    }
  };
}

async function settles(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = nativeSetTimeout(() => reject(new Error('MCP request did not settle promptly')), 1200);
      })
    ]);
  } finally {
    nativeClearTimeout(timer);
  }
}

// Shorten only tools/call deadlines; idle timers retain their existing lifetime.
function watchTimers(t, requestTimeoutMs = 30000) {
  const active = new Set();
  t.mock.method(globalThis, 'setTimeout', (callback, timeoutMs, ...args) => {
    const timer = nativeSetTimeout((...values) => {
      active.delete(timer);
      callback(...values);
    }, timeoutMs === 30000 ? requestTimeoutMs : timeoutMs, ...args);
    if (timeoutMs !== 5 * 60 * 1000) active.add(timer); // Keep the existing idle timer.
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    active.delete(timer);
    return nativeClearTimeout(timer);
  });
  return active;
}

function assertFailure(result, kind, retryable = null) {
  assert.equal(result.ok, false);
  assert.deepEqual(result.meta?.failure, { kind, retryable });
}

function assertNoAbortListener(signal) {
  assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('MCP isError is a registry failure, not a successful error string', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await f.invoke({
    op: 'result', result: { isError: true, content: [{ type: 'text', text: 'fixture tool failure' }] }
  }, { signal: controller.signal });
  assertFailure(result, 'mcp-error');
  assert.match(result.result, /isError.*\nfixture tool failure/);
  assertNoAbortListener(controller.signal);
  controller.abort();
  const stats = await f.stats();
  assert.equal(stats.calls.filter(({ op }) => op === 'result').length, 1, 'never auto-retry tools/call');
  assert.deepEqual(stats.cancelled, []);
  assert.equal(timers.size, 0);
});

test('MCP JSON-RPC errors and serialization throws remain registry failures', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t);
  const controller = new AbortController();
  const remote = await f.invoke({ op: 'rpc-error' }, { signal: controller.signal });
  assertFailure(remote, 'mcp-error');
  assert.match(remote.result, /-32603.*fixture remote failure/);
  assertNoAbortListener(controller.signal);
  const circular = { op: 'result' };
  circular.self = circular;
  const thrown = await f.invoke(circular, { signal: controller.signal });
  assertFailure(thrown, 'mcp-error');
  assert.match(thrown.result, /circular/i);
  assertNoAbortListener(controller.signal);
  controller.abort();
  const stats = await f.stats();
  assert.equal(stats.calls.length, 1);
  assert.deepEqual(stats.cancelled, []);
  assert.equal(timers.size, 0);
});

test('MCP request timeout is classified without retrying or killing the server', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const timers = watchTimers(t, 150);
  const controller = new AbortController();
  const result = await settles(f.invoke({ op: 'wait', label: 'timeout' }, { signal: controller.signal }));
  assertFailure(result, 'mcp-timeout');
  assert.match(result.result, /请求超时/);
  assertNoAbortListener(controller.signal);
  controller.abort();
  const stats = await f.stats();
  assert.equal(stats.calls.filter(({ label }) => label === 'timeout').length, 1);
  assert.deepEqual(stats.cancelled, [], 'a settled request must not send a late cancellation');
  assert.equal((await f.invoke({ op: 'release', label: 'timeout' })).ok, true);
  assert.equal(timers.size, 0);
});

test('cancelling one request leaves its shared-process peer successful', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t);
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = f.invoke({ op: 'wait', label: 'cancel' }, { signal: first.signal });
  const surviving = f.invoke({ op: 'wait', label: 'survive' }, { signal: second.signal });
  const before = await f.stats(); // A stdio ordering barrier, not a sleep/poll.
  assert.equal(before.calls.length, 2);
  first.abort();
  const result = await settles(cancelled);
  assertFailure(result, 'aborted', false);
  assert.match(result.result, /中止|取消/);
  assertNoAbortListener(first.signal);
  assert.equal(getEventListeners(second.signal, 'abort').length, 1);
  const afterCancel = await f.stats();
  assert.equal(afterCancel.pid, before.pid);
  assert.equal(afterCancel.cancelled.length, 1);
  assert.equal(afterCancel.cancelled[0].requestId, before.calls.find(({ label }) => label === 'cancel').id);
  assert.equal((await f.invoke({ op: 'release', label: 'survive' })).ok, true);
  const peer = await settles(surviving);
  assert.equal(peer.ok, true);
  assert.equal(peer.result, 'completed:survive');
  assertNoAbortListener(second.signal);
  second.abort();
  assert.equal((await f.stats()).cancelled.length, 1);
  assert.equal(timers.size, 0);
});

test('an already-aborted execute sends neither a tool request nor a new connection', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  stopMcpClient(f.name);
  const controller = new AbortController();
  controller.abort();
  // Inject at the execute boundary so the registry preflight cannot mask an MCP bug.
  const registry = createToolRegistry(f.tools.map((tool) => ({
    ...tool, execute: (args, context) => tool.execute(args, { ...context, signal: controller.signal })
  })), (value) => value);
  const before = children.length;
  const result = await registry.invoke(
    { function: { name: f.tools[0].name } }, { op: 'result' }, { cwd: testHome }
  );
  assertFailure(result, 'aborted', false);
  assert.equal(children.length, before);
  assertNoAbortListener(controller.signal);
});

test('aborting while reconnecting cannot send tools/call after the handshake', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t, { initializeDelayMs: 60 });
  stopMcpClient(f.name);
  const controller = new AbortController();
  const before = children.length;
  const pending = f.invoke({ op: 'result' }, { signal: controller.signal });
  assert.equal(children.length, before + 1, 'the shared handshake has started');
  controller.abort();
  assertFailure(await settles(pending), 'aborted', false);
  assert.deepEqual((await f.stats()).calls, []);
  assertNoAbortListener(controller.signal);
  assert.equal(timers.size, 0);
});

test('MCP discovery accepts an abort signal without stopping a shared handshake', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const { cfg } = serverConfig(t, { initializeDelayMs: 60 });
  const controller = new AbortController();
  const before = children.length;
  controller.abort();
  assert.deepEqual(await buildMcpTools(cfg, { signal: controller.signal }), []);
  assert.equal(children.length, before);
  const during = new AbortController();
  const pending = buildMcpTools(cfg, { timeoutMs: 2000, signal: during.signal });
  during.abort();
  assert.deepEqual(await settles(pending), []);
  const tools = await buildMcpTools(cfg, { timeoutMs: 2000 });
  assert.equal(tools.length, 1);
  assert.equal(children.length, before + 1, 'discovery cancellation must not kill the shared process');
  assertNoAbortListener(during.signal);

  const slow = serverConfig(t, { initializeDelayMs: 60 });
  const mixed = new AbortController();
  const partial = buildMcpTools({
    mcpServers: { ...cfg.mcpServers, ...slow.cfg.mcpServers }
  }, { timeoutMs: 2000, signal: mixed.signal });
  await Promise.resolve(); // The cached server's tools have populated the partial result.
  mixed.abort();
  assert.deepEqual(await settles(partial), [], 'do not return tools collected before cancellation');
  assert.equal(children.length, before + 2);
  assert.equal(timers.size, 0);
});

test('MCP process exit rejects all pending calls and removes timers/listeners', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t);
  const first = new AbortController();
  const second = new AbortController();
  const waiting = f.invoke({ op: 'wait', label: 'exit' }, { signal: first.signal });
  assert.equal((await f.stats()).calls.length, 1);
  const exiting = f.invoke({ op: 'exit' }, { signal: second.signal });
  for (const result of await settles(Promise.all([waiting, exiting]))) {
    assertFailure(result, 'mcp-error');
    assert.match(result.result, /已退出/);
  }
  assertNoAbortListener(first.signal);
  assertNoAbortListener(second.signal);
  assert.equal(timers.size, 0);
});

test('MCP stdin write throws clean up the registered request', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t);
  const controller = new AbortController();
  const { proc } = children.at(-1);
  const write = t.mock.method(proc.stdin, 'write', () => { throw new Error('fixture write failure'); });
  const result = await f.invoke({ op: 'result' }, { signal: controller.signal });
  assertFailure(result, 'mcp-error');
  assert.match(result.result, /fixture write failure/);
  assertNoAbortListener(controller.signal);
  assert.equal(timers.size, 0);
  write.mock.restore();
  controller.abort();
  assert.deepEqual((await f.stats()).calls, []);
});

test('MCP asynchronous write and stdin errors clean up pending calls', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t);
  const controller = new AbortController();
  const { proc } = children.at(-1);
  const write = t.mock.method(proc.stdin, 'write', (_payload, callback) => {
    queueMicrotask(() => callback(new Error('fixture callback failure')));
    return true;
  });
  const failedWrite = await f.invoke({ op: 'result' }, { signal: controller.signal });
  assertFailure(failedWrite, 'mcp-error');
  assert.match(failedWrite.result, /fixture callback failure/);
  assertNoAbortListener(controller.signal);
  assert.equal(timers.size, 0);
  write.mock.restore();

  const pending = f.invoke({ op: 'wait', label: 'pipe-error' }, { signal: controller.signal });
  assert.equal((await f.stats()).calls.length, 1);
  proc.stdin.emit('error', new Error('fixture pipe failure'));
  const failedPipe = await settles(pending);
  assertFailure(failedPipe, 'mcp-error');
  assert.match(failedPipe.result, /fixture pipe failure/);
  assertNoAbortListener(controller.signal);
  assert.equal(timers.size, 0);
  assert.equal((await f.invoke({ op: 'release', label: 'pipe-error' })).ok, true);
});

test('failed cancellation notification still aborts only its own request', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.invoke({ op: 'wait', label: 'cancel' }, { signal: controller.signal });
  const peer = f.invoke({ op: 'wait', label: 'peer' });
  const before = await f.stats();
  const { proc } = children.at(-1);
  const originalWrite = proc.stdin.write;
  let attempts = 0;
  const write = t.mock.method(proc.stdin, 'write', function (payload, ...args) {
    if (JSON.parse(payload).method === 'notifications/cancelled') {
      attempts++;
      throw new Error('fixture cancellation notification failure');
    }
    return originalWrite.call(this, payload, ...args);
  });
  controller.abort();
  assertFailure(await settles(pending), 'aborted', false);
  assert.equal(attempts, 1);
  assertNoAbortListener(controller.signal);
  write.mock.restore();
  assert.equal((await f.invoke({ op: 'release', label: 'peer' })).ok, true);
  assert.equal((await settles(peer)).result, 'completed:peer');
  const afterCancel = await f.stats();
  assert.equal(afterCancel.pid, before.pid);
  assert.deepEqual(afterCancel.cancelled, []);
  assert.equal(timers.size, 0);
});

test('an unavailable MCP placeholder reports registry failure', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t, { exitOnInitialize: true });
  assert.match(f.tools[0].name, /__unavailable$/);
  const result = await f.invoke({});
  assertFailure(result, 'mcp-error');
  assert.match(result.result, /不可用/);
  assert.equal(timers.size, 0);
});

test('successful MCP text/image/resource/empty summaries retain limits and compatibility', { timeout: 5000 }, async (t) => {
  const timers = watchTimers(t);
  const f = await fixture(t);
  const controller = new AbortController();
  const cases = [
    [{ content: [{ type: 'text', text: '  hello  ' }] }, 'hello'],
    [{ content: [{ type: 'text', text: 'abcdefghij' }] }, 'abcd\n…（截断，共 10 字符）', 4],
    [{ content: [{ type: 'image', data: 'not-for-text-output', mimeType: 'image/png' }] }, /返回了一张图片/],
    [{ content: [{ type: 'resource', resource: { text: 'not-for-text-output' } }] }, /返回了非文本内容/],
    [{ content: [] }, /服务器返回了空内容/]
  ];
  for (const [response, expected, limit] of cases) {
    const result = await f.invoke({ op: 'result', result: response }, {
      signal: controller.signal, toolOutputLimit: limit
    });
    assert.equal(result.ok, true);
    assert.equal(result.meta, null);
    if (typeof expected === 'string') assert.equal(result.result, expected);
    else assert.match(result.result, expected);
    assertNoAbortListener(controller.signal);
  }
  assert.equal(await f.tools[0].execute({}), 'ok', 'preserve successful direct-call text compatibility');
  controller.abort();
  assert.deepEqual((await f.stats()).cancelled, []);
  assert.equal(timers.size, 0);
});
