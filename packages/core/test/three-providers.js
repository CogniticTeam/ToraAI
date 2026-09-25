// Google Gemini / Anthropic / 阶跃星辰接入回归；只模拟上游，不使用真实密钥。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'cocode-provider-test-'));
process.env.COCODE_HOME = testHome;
const realFetch = globalThis.fetch;

try {
  const { startASAPIServer } = await import('../src/asapi/server.js');
  const { chatCompletion, createClient } = await import('../src/model.js');
  const server = await startASAPIServer({ port: 0 });
  try {
    const local = `http://127.0.0.1:${server.address().port}`;
    const cases = [
      {
        provider: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        returned: ['gemini-3.8-flash', 'gemini-3.8-live', 'gemini-embedding-001', 'gemma-4-31b-it'],
        expected: ['gemini-3.8-flash'],
        header: ['x-goog-api-client', 'cocode-desktop/1.0.0'],
      },
      {
        provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1',
        returned: ['claude-opus-5-5', 'claude-sonnet-5'],
        expected: ['claude-opus-5-5', 'claude-sonnet-5'],
        header: ['anthropic-version', '2023-06-01'],
      },
      {
        provider: 'stepfun', baseURL: 'https://api.stepfun.com/v1',
        returned: ['step-3.7-flash', 'step-5-preview', 'step-audio-3', 'step-1v-32k'],
        expected: ['step-3.7-flash', 'step-5-preview', 'step-1v-32k'],
      },
      {
        provider: 'stepfun-global', baseURL: 'https://api.stepfun.ai/v1',
        returned: ['step-3.7-flash', 'step-audio-3'],
        expected: ['step-3.7-flash'],
      },
    ];
    for (const item of cases) {
      let upstream;
      globalThis.fetch = async (url, init) => {
        upstream = { url: String(url), headers: init.headers };
        return Response.json({ data: item.returned.map((id) => ({ id })) });
      };
      const response = await realFetch(local + '/admin/models', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: item.provider, baseURL: item.baseURL, apiKey: 'test-key' }),
      });
      assert.equal(response.status, 200, item.provider);
      assert.deepEqual((await response.json()).models, item.expected, item.provider);
      assert.equal(upstream.url, item.baseURL + (item.provider === 'anthropic' ? '/models?limit=1000' : '/models'));
      if (item.provider === 'anthropic') {
        assert.equal(upstream.headers['x-api-key'], 'test-key');
        assert.equal(upstream.headers.authorization, undefined);
      } else assert.equal(upstream.headers.authorization, 'Bearer test-key');
      if (item.header) assert.equal(upstream.headers[item.header[0]], item.header[1]);
    }

    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ choices: [{ message: { role: 'assistant', content: '可以' } }] });
    };
    const messages = [{ role: 'user', content: '你好' }];
    const tools = [{ type: 'function', function: { name: 'ping', description: 'test', parameters: { type: 'object', properties: {} } } }];

    await chatCompletion(createClient({ baseURL: cases[0].baseURL, apiKey: 'test-key', model: 'gemini-3.8-flash' }), { messages, tools });
    assert.equal(requests.at(-1).url, cases[0].baseURL + '/chat/completions');
    assert.equal(requests.at(-1).headers['x-goog-api-client'], 'cocode-desktop/1.0.0');
    assert.equal(requests.at(-1).body.reasoning_effort, 'high');
    assert.equal(requests.at(-1).body.enable_thinking, undefined);

    const stepClient = createClient({ baseURL: cases[2].baseURL, apiKey: 'test-key', model: 'step-3.7-flash', thinking: false });
    assert.equal(stepClient.vision, true);
    await chatCompletion(stepClient, { messages, tools });
    assert.equal(requests.at(-1).url, cases[2].baseURL + '/chat/completions');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer test-key');
    console.log('Google、Anthropic、阶跃星辰模型发现；Google、阶跃星辰兼容对话接入通过');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  globalThis.fetch = realFetch;
  rmSync(testHome, { recursive: true, force: true });
}
