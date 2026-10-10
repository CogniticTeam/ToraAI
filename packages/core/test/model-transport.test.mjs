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

test('free-work quota errors retain the business code and show readable detail',async()=>{
  setModelFetcher(async()=>Response.json({code:'doubao_work_limit',detail:'今日豆包工作额度已用完'},{status:429}));
  await assert.rejects(chatCompletion(createClient(cfg),{messages}),error=>{
    assert.equal(error.code,'doubao_work_limit');assert.match(error.message,/今日豆包工作额度已用完/);
    assert.ok(!error.message.includes('{'));return true;
  });
});
