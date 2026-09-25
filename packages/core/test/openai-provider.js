// OpenAI 模型接入回归测试；全程 mock 上游，不使用真实 API Key。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'cocode-openai-test-'));
process.env.COCODE_HOME = testHome;
const realFetch = globalThis.fetch;

try {
  const { startASAPIServer } = await import('../src/asapi/server.js');
  const { chatCompletion, createClient } = await import('../src/model.js');
  const server = await startASAPIServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    let received;
    globalThis.fetch = async (url, init) => {
      received = { url: String(url), init };
      return Response.json({ data: [
        { id: 'gpt-4o' }, { id: 'gpt-5.5' }, { id: 'gpt-6-sol' },
        { id: 'gpt-image-2' }, { id: 'text-embedding-3-large' },
        { id: 'gpt-5.5-pro' }, { id: 'gpt-4o-realtime-preview' },
      ] });
    };
    const res = await realFetch(base + '/admin/models', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'test-secret' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).models, ['gpt-4o', 'gpt-5.5', 'gpt-6-sol']);
    assert.equal(received.url, 'https://api.openai.com/v1/models');
    assert.equal(received.init.headers.authorization, 'Bearer test-secret');

    const response = () => Response.json({ choices: [{ message: { role: 'assistant', content: '好的' } }] });
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return response();
    };
    const cfg = { baseURL: 'https://api.openai.com/v1', apiKey: 'test-secret', temperature: 0.7 };
    const messages = [{ role: 'user', content: '你好' }];
    const tools = [{ type: 'function', function: { name: 'ping', description: '测试', parameters: { type: 'object', properties: {} } } }];

    await chatCompletion(createClient({ ...cfg, model: 'gpt-4o' }), { messages, tools });
    assert.equal(requests.at(-1).body.enable_thinking, undefined);
    assert.equal(requests.at(-1).body.reasoning_effort, undefined);
    assert.equal(requests.at(-1).body.temperature, 0.7);

    await chatCompletion(createClient({ ...cfg, model: 'gpt-5.5' }), { messages, tools });
    assert.equal(requests.at(-1).body.reasoning_effort, 'high');
    assert.equal(requests.at(-1).body.temperature, undefined);
    assert.equal(requests.at(-1).body.tools.length, 1);

    await chatCompletion(createClient({ ...cfg, model: 'gpt-6-sol' }), { messages, tools });
    assert.equal(requests.at(-1).body.reasoning_effort, 'none');
    assert.equal(requests.at(-1).body.tools.length, 1);

    await chatCompletion(createClient({ ...cfg, model: 'gpt-6-sol' }), { messages });
    assert.equal(requests.at(-1).body.reasoning_effort, 'high');

    const astra = createClient({ ...cfg, model: 'gpt-6-astra' });
    assert.equal(astra.supportsTools, false);
    assert.equal(astra.vision, true);
    await chatCompletion(astra, { messages, tools });
    assert.equal(requests.at(-1).body.tools, undefined);
    console.log('OpenAI 模型发现和 Chat Completions 适配通过');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  globalThis.fetch = realFetch;
  rmSync(testHome, { recursive: true, force: true });
}
