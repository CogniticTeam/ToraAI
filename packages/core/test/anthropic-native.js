// 不使用真实密钥：验证 Claude 原生 Messages API 的流式、工具和多模态转换。
import assert from 'node:assert/strict';
import { chatCompletion, createClient } from '../src/model.js';

const originalFetch = globalThis.fetch;
const client = createClient({
  provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1',
  apiKey: 'test-key', model: 'claude-sonnet-5', thinkingEffort: 'medium'
});
const tool = { type: 'function', function: {
  name: 'Read', description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
} };

function sse(events) {
  const bytes = new TextEncoder().encode(events.map((event) =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
}

try {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-thinking' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', usage: { output_tokens: 9 } },
      { type: 'message_stop' }
    ]);
  };
  const text = [];
  const thinking = [];
  const first = await chatCompletion(client, {
    messages: [{ role: 'system', content: '系统提示' }, { role: 'user', content: '读取文件' }],
    tools: [tool], onDelta: (delta) => text.push(delta), onThinking: (delta) => thinking.push(delta)
  });
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], 'test-key');
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].body.system, '系统提示');
  assert.equal(requests[0].body.max_tokens, 8192);
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.tools[0], {
    name: 'Read', description: 'Read a file', input_schema: tool.function.parameters
  });
  assert.deepEqual(requests[0].body.thinking, { type: 'adaptive' });
  assert.deepEqual(requests[0].body.output_config, { effort: 'medium' });
  assert.deepEqual(text, ['你好']);
  assert.deepEqual(thinking, ['先看']);
  assert.equal(first.message.content, '你好');
  assert.deepEqual(first.message.tool_calls, [{ id: 'tool-1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }]);
  assert.deepEqual(first.usage, { prompt_tokens: 15, completion_tokens: 9, cached_tokens: 3 });
  assert.equal(first.message.anthropic_content[0].signature, 'signed-thinking');

  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ content: [{ type: 'text', text: '完成' }], usage: { input_tokens: 20, output_tokens: 4 } });
  };
  const second = await chatCompletion(client, { messages: [
    { role: 'user', content: [{ type: 'text', text: '图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } }] },
    first.message,
    { role: 'tool', tool_call_id: 'tool-1', tool_state: 'success', content: '文件内容' }
  ] });
  assert.equal(second.message.content, '完成');
  assert.equal(requests[1].body.messages[0].content[1].source.media_type, 'image/png');
  assert.equal(requests[1].body.messages[1].content[0].signature, 'signed-thinking');
  assert.equal(requests[1].body.messages[1].content[2].input.path, 'a.txt');
  assert.equal(requests[1].body.messages[2].content[0].tool_use_id, 'tool-1');
  assert.deepEqual(second.usage, { prompt_tokens: 20, completion_tokens: 4, cached_tokens: 0 });

  const proxy = createClient({ provider: 'anthropic', baseURL: 'https://proxy.example/v1', apiKey: 'test-key', model: 'claude-opus-5-5', thinking: false });
  await chatCompletion(proxy, { messages: [
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a', function: { name: 'Read', arguments: '{"path":"a"}' } },
      { id: 'b', function: { name: 'Read', arguments: '{"path":"b"}' } }
    ] },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'tool', tool_call_id: 'b', content: 'B' }
  ] });
  assert.equal(requests[2].url, 'https://proxy.example/v1/messages');
  assert.equal(requests[2].body.messages.length, 2);
  assert.equal(requests[2].body.messages[1].content.length, 2);
  assert.equal(requests[2].body.thinking, undefined, 'always-on 模型不能禁用思考');
  assert.deepEqual(requests[2].body.output_config, { effort: 'low' });

  globalThis.fetch = async () => sse([{ type: 'error', error: { message: 'overloaded' } }]);
  await assert.rejects(chatCompletion(client, { messages: [{ role: 'user', content: 'hello' }] }), /overloaded/);
  globalThis.fetch = async () => Response.json({ error: { message: 'tool use is not supported' } }, { status: 400 });
  await assert.rejects(chatCompletion(client, { messages: [{ role: 'user', content: 'hello' }], tools: [tool] }),
    (error) => error.code === 'TOOL_UNSUPPORTED');
  console.log('Anthropic 原生流式、签名思考、工具结果、图片和错误事件通过');
} finally {
  globalThis.fetch = originalFetch;
}
