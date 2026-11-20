import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setModelFetcher, modelFetch } from '../src/model-transport.js';
import { createClient, chatCompletion } from '../src/model.js';
import { generateTitle } from '../src/title.js';

const nodeFetch = globalThis.fetch;
afterEach(() => { setModelFetcher(null); globalThis.fetch = nodeFetch; });
const cfg = { baseURL: 'https://model.fixture.invalid/v1', apiKey: 'synthetic-secret', model: 'fixture', thinking: false };
const messages = [{ role: 'user', content: '连接测试' }];

test('CLI keeps the current Node fetch and desktop transport can be reset', async () => {
  globalThis.fetch = async () => new Response('node');
  assert.equal(await (await modelFetch('https://fixture.invalid')).text(), 'node');
  setModelFetcher(async () => new Response('desktop'));
  assert.equal(await (await modelFetch('https://fixture.invalid')).text(), 'desktop');
  setModelFetcher(null);
  assert.equal(await (await modelFetch('https://fixture.invalid')).text(), 'node');
  assert.throws(() => setModelFetcher({}), TypeError);
});

test('desktop model transport preserves auth, cancellation, streaming and usage', async () => {
  const controller = new AbortController(), deltas = [];
  globalThis.fetch = () => { throw new Error('Node transport must not run'); };
  setModelFetcher(async (url, init) => {
    assert.equal(url, cfg.baseURL + '/chat/completions');
    assert.equal(init.headers.authorization, 'Bearer synthetic-secret');
    assert.equal(init.signal, controller.signal);
    assert.equal(JSON.parse(init.body).stream, true);
    const chunks = [
      'data: {"choices":[{"delta":{"content":"连接"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"正常"}}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ];
    return new Response(new ReadableStream({ start(stream) { for (const text of chunks) stream.enqueue(new TextEncoder().encode(text)); stream.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const result = await chatCompletion(createClient(cfg), { messages, signal: controller.signal, onDelta: text => deltas.push(text) });
  assert.equal(result.message.content, '连接正常');
  assert.deepEqual(deltas, ['连接', '正常']);
  assert.equal(result.usage.completion_tokens, 2);
});

test('native Claude and official title requests also use injected transport', async () => {
  const urls = [];
  globalThis.fetch = () => { throw new Error('Node transport must not run'); };
  setModelFetcher(async (url, init) => {
    urls.push(url);
    if (url.endsWith('/messages')) {
      assert.equal(init.headers['x-api-key'], 'synthetic-secret');
      return Response.json({ content: [{ type: 'text', text: '正常' }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    assert.equal(init.headers.authorization, 'Bearer synthetic-secret');
    return Response.json({ title: '连接测试' });
  });
  assert.equal((await chatCompletion(createClient({ ...cfg, provider: 'anthropic', model: 'claude-haiku-5-5' }), { messages })).message.content, '正常');
  assert.equal(await generateTitle({ ...cfg, provider: 'tochat-official' }, { userText: '连接测试', language: 'zh' }), '连接测试');
  assert.deepEqual(urls, [cfg.baseURL + '/messages', 'https://model.fixture.invalid/title']);
});

test('connection failures retain diagnostic cause without leaking secrets or retrying POST', async () => {
  let attempts = 0;
  const cause = new TypeError('request with synthetic-secret failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  setModelFetcher(async () => { attempts++; throw cause; });
  await assert.rejects(chatCompletion(createClient(cfg), { messages }), error => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
    assert.ok(!error.message.includes('synthetic-secret'));
    return true;
  });
  assert.equal(attempts, 1);
});

test('cancelled model requests remain ABORTED and are never retried', async () => {
  const controller = new AbortController(); let attempts = 0;
  setModelFetcher(async (_url, init) => { attempts++; controller.abort(); throw init.signal.reason; });
  await assert.rejects(chatCompletion(createClient(cfg), { messages, signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(attempts, 1);
});

for (const contentType of ['text/event-stream', 'text/plain', 'application/json', '']) {
  test(`compatible models stream before EOF with ${contentType || 'missing Content-Type'}`, async () => {
    let release, waiting;
    const blocked = new Promise(resolve => { waiting = resolve; });
    const encoder = new TextEncoder();
    setModelFetcher(async (_url, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      let reads = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (++reads === 1) controller.enqueue(encoder.encode(': connected\r\n\r\ndata: {"choices":[{"delta":{"content":"正在输出🙂"}}]}\r\n\r\n'));
        else {
          release = () => { controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"完成"}}]}\r\n\r\ndata: [DONE]\r\n\r\n')); controller.close(); };
          waiting();
        }
      } }, { highWaterMark: 0 }), { headers: contentType ? { 'content-type': contentType } : {} });
    });
    const deltas = [], task = chatCompletion(createClient(cfg), { messages, onDelta: text => deltas.push(text) });
    try {
      await Promise.race([blocked, task.then(() => { throw Error('Response ended before the stream was released'); })]);
      assert.deepEqual(deltas, ['正在输出🙂'], 'The first delta must arrive while the response body is still open');
      release(); release = null;
      assert.equal((await task).message.content, '正在输出🙂完成');
    } finally { release?.(); await task.catch(() => {}); }
  });
}

test('complete JSON replies notify the same display callback without fabricating a stream', async () => {
  setModelFetcher(async () => Response.json({ choices: [{ message: { role: 'assistant', content: '完整回复', reasoning_content: '思考摘要' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  const deltas = [], thoughts = [];
  const result = await chatCompletion(createClient(cfg), { messages, onDelta: text => deltas.push(text), onThinking: text => thoughts.push(text) });
  assert.equal(result.message.content, '完整回复');
  assert.deepEqual(deltas, ['完整回复']);
  assert.deepEqual(thoughts, ['思考摘要']);
  assert.equal(result.usage.completion_tokens, 3);
});

test('the final SSE delta is preserved when EOF has no trailing newline', async () => {
  setModelFetcher(async () => new Response('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\ndata: {"choices":[{"delta":{"content":"最后一段"}}]}', { headers: { 'content-type': 'text/event-stream' } }));
  const deltas = [];
  const result = await chatCompletion(createClient(cfg), { messages, onDelta: text => deltas.push(text) });
  assert.equal(result.message.content, '第一段最后一段');
  assert.deepEqual(deltas, ['第一段', '最后一段']);
});

for (const newline of ['\n', '\r\n', '\r']) {
  test(`SSE handles multiline data and byte-split Unicode with ${JSON.stringify(newline)} framing`, async () => {
    const body = [': heartbeat', 'event: message', 'data: {', 'data: "choices":[{"delta":{"content":"文字🙂"}}]', 'data: }', '', 'data: [DONE]', ''].join(newline);
    const bytes = new TextEncoder().encode(body);
    setModelFetcher(async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { headers: { 'content-type': 'text/plain' } }));
    const deltas = [];
    assert.equal((await chatCompletion(createClient(cfg), { messages, onDelta: text => deltas.push(text) })).message.content, '文字🙂');
    assert.deepEqual(deltas, ['文字🙂']);
  });
}

test('DONE closes an SSE reader without waiting for the upstream connection to end', async () => {
  let cancelled = 0;
  setModelFetcher(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n')); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal((await chatCompletion(createClient(cfg), { messages })).message.content, '完成');
  assert.equal(cancelled, 1);
});

test('cancelling an open mislabeled stream releases its reader and preserves ABORTED', async () => {
  const controller = new AbortController();
  let waiting, cancelled = 0;
  const blocked = new Promise(resolve => { waiting = resolve; });
  setModelFetcher(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"首段"}}]}\n\n')); },
    pull() { waiting(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }));
  const deltas = [], task = chatCompletion(createClient(cfg), { messages, signal: controller.signal, onDelta: text => deltas.push(text) });
  await Promise.race([blocked, task.then(() => { throw Error('Stream ended before cancellation'); })]);
  assert.deepEqual(deltas, ['首段']);
  controller.abort();
  await assert.rejects(task, { code: 'ABORTED' });
  assert.equal(cancelled, 1);
});

test('streamed parallel tool calls retain arguments, reasoning and cached usage', async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: '先检查文件', tool_calls: [{ index: 0, id: 'read_1', function: { name: 'Read', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'glob_1', function: { name: 'Glob', arguments: '{"pattern":"*.js"}' } }, { index: 0, function: { arguments: '"a.txt"}' } }] } }] },
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } },
  ];
  setModelFetcher(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/plain' } }));
  const thoughts = [];
  const result = await chatCompletion(createClient(cfg), { messages, onThinking: text => thoughts.push(text) });
  assert.deepEqual(result.message.tool_calls.map(call => [call.id, call.function.name, JSON.parse(call.function.arguments)]), [['read_1', 'Read', { path: 'a.txt' }], ['glob_1', 'Glob', { pattern: '*.js' }]]);
  assert.deepEqual(thoughts, ['先检查文件']);
  assert.equal(result.usage.cached_tokens, 3);
});

test('JSON tool-only replies retain the existing tool-call result contract', async () => {
  setModelFetcher(async () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'Read', arguments: '{"path":"a.txt"}' } }] } }] }));
  const deltas = [];
  const result = await chatCompletion(createClient(cfg), { messages, onDelta: text => deltas.push(text) });
  assert.equal(result.message.tool_calls[0].id, 'call_0');
  assert.equal(result.message.tool_calls[0].function.name, 'Read');
  assert.deepEqual(deltas, []);
});

test('free-work quota errors retain the business code and show readable detail',async()=>{
  setModelFetcher(async()=>Response.json({code:'doubao_work_limit',detail:'今日豆包工作额度已用完'},{status:429}));
  await assert.rejects(chatCompletion(createClient(cfg),{messages}),error=>{
    assert.equal(error.code,'doubao_work_limit');assert.match(error.message,/今日豆包工作额度已用完/);
    assert.ok(!error.message.includes('{'));return true;
  });
});
