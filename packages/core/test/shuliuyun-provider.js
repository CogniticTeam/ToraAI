// Shuliuyun transport and model discovery; mocks only, no real keys or paid calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'tora-shuliuyun-provider-'));
process.env.TORA_HOME = testHome;
const realFetch = globalThis.fetch;
const key = 'shuliuyun-test-key-not-a-real-credential';
const endpoint = 'https://shuliuyun.com/v1';
let server;
try {
  const { startASAPIServer } = await import('../src/asapi/server.js');
  const { chatCompletion, createClient } = await import('../src/model.js');
  server = await startASAPIServer({ port: 0 });
  const local = `http://127.0.0.1:${server.address().port}`;
  let received;
  const discover = () => realFetch(local + '/admin/models', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'shuliuyun', baseURL: endpoint, apiKey: key }),
  });
  globalThis.fetch = async (url, init) => {
    received = { url: String(url), headers: init.headers };
    return Response.json({ data: ['gpt-5.4-mini','claude-sonnet-4-6','gemini-3.1-pro-preview','deepseek-flash',
      'gpt-image-2','sora-2','veo-3.1','seedance-2.0','seedream-5.0','text-embedding-3-small',
      'gpt-5.5-pro','whisper-1','gemini-3-pro-image-preview'].map(id => ({ id })) });
  };
  let response = await discover();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).models, ['gpt-5.4-mini','claude-sonnet-4-6','gemini-3.1-pro-preview','deepseek-flash']);
  assert.equal(received.url, endpoint + '/models');
  assert.equal(received.headers.authorization, 'Bearer ' + key);
  assert.equal(received.headers['x-api-key'], undefined);
  for (const status of [401,429,500]) {
    globalThis.fetch = async () => Response.json({ error: { message: 'test upstream error' } }, { status });
    response = await discover();
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.ok(body.includes(String(status)));
    assert.ok(!body.includes(key));
  }
  globalThis.fetch = async () => { throw new Error('test timeout'); };
  response = await discover();
  assert.equal(response.status, 502);
  assert.ok((await response.text()).includes('test timeout'));

  const messages = [{ role: 'user', content: [
    { type: 'text', text: 'Describe the image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ] }];
  const tools = [{ type: 'function', function: { name: 'ping', description: 'test', parameters: { type: 'object', properties: {} } } }];
  globalThis.fetch = async (url, init) => {
    received = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    const events = [
      { choices: [{ delta: { reasoning_content: 'Thinking', content: 'Hello ' } }] },
      { choices: [{ delta: { content: 'Shuliuyun', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'ping', arguments: '{"ok":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'true}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  for (const effort of ['low', 'medium', 'high']) {
    await chatCompletion(createClient({ provider: 'shuliuyun', baseURL: endpoint, apiKey: key, model: 'gemini-3.8-flash', thinking: true, thinkingEffort: effort }), { messages, tools });
    assert.equal(received.body.reasoning_effort, effort);
    assert.equal(received.body.enable_thinking, undefined);
    assert.equal(received.body.thinking, undefined);
  }
  let deltas = '', thinking = '';
  const result = await chatCompletion(createClient({ provider: 'shuliuyun', baseURL: endpoint, apiKey: key, model: 'gpt-5.4-mini', temperature: .7 }), {
    messages, tools, onDelta: text => { deltas += text; }, onThinking: text => { thinking += text; },
  });
  assert.equal(received.url, endpoint + '/chat/completions');
  assert.equal(received.headers.authorization, 'Bearer ' + key);
  assert.equal(received.body.stream, true);
  assert.equal(received.body.reasoning_effort, 'high');
  assert.equal(received.body.enable_thinking, undefined);
  assert.equal(received.body.temperature, undefined);
  assert.deepEqual(received.body.messages[0].content, messages[0].content);
  assert.equal(deltas, 'Hello Shuliuyun');
  assert.equal(thinking, 'Thinking');
  assert.equal(result.message.tool_calls[0].function.arguments, '{"ok":true}');
  await chatCompletion(createClient({ provider: 'shuliuyun', baseURL: endpoint, apiKey: key, model: 'claude-sonnet-4-6', thinking: false }), { messages, tools });
  assert.equal(received.url, endpoint + '/chat/completions');
  assert.equal(received.headers['anthropic-version'], undefined);
  await chatCompletion(createClient({ baseURL: 'https://shuliuyun.com/v1', apiKey: key, model: 'gpt-6-sol' }), { messages, tools });
  assert.equal(received.body.reasoning_effort, 'none');
  assert.equal(createClient({ provider: 'shuliuyun', baseURL: endpoint, apiKey: key, model: 'gpt-6-astra' }).supportsTools, true);
  assert.throws(() => createClient({ provider: 'shuliuyun', baseURL: endpoint, apiKey: '', model: 'gpt-5.4-mini' }), /apiKey/);
  console.log('Shuliuyun discovery, auth/errors, SSE, tools, vision and OpenAI-compatible model parameters verified.');
} finally {
  globalThis.fetch = realFetch;
  server?.closeAllConnections?.();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(testHome, { recursive: true, force: true });
}
