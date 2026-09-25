// Claude 原生 Messages API 适配器。Agent 内部仍使用 OpenAI 风格消息，
// 仅在边界转换输入、流式事件和工具调用；其他模型不经过此文件。

function clean(value) {
  const text = String(value ?? '');
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

function imageBlock(url) {
  const value = typeof url === 'string' ? url : url?.url;
  if (typeof value !== 'string') throw new Error('Claude 图片附件缺少 URL');
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(value);
  if (data) return { type: 'image', source: { type: 'base64', media_type: data[1].toLowerCase(), data: data[2] } };
  if (/^https:\/\//i.test(value)) return { type: 'image', source: { type: 'url', url: value } };
  throw new Error('Claude 仅支持 HTTPS 或 PNG/JPEG/GIF/WebP Base64 图片');
}

function contentBlocks(content, allowImages = true) {
  if (!Array.isArray(content)) return [{ type: 'text', text: clean(content) }];
  const blocks = [];
  for (const part of content) {
    if (part?.type === 'text') blocks.push({ type: 'text', text: clean(part.text) });
    else if (part?.type === 'image_url' && allowImages) blocks.push(imageBlock(part.image_url));
  }
  return blocks.length ? blocks : [{ type: 'text', text: '[图片附件已省略：当前模型不支持视觉输入]' }];
}

function toolInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function toNativeMessages(messages, allowImages) {
  const system = [];
  const native = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(Array.isArray(m.content)
        ? m.content.filter((p) => p?.type === 'text').map((p) => clean(p.text)).join('\n')
        : clean(m.content));
      continue;
    }
    if (m.role === 'tool') {
      const blocks = contentBlocks(m.content, allowImages);
      const result = {
        type: 'tool_result', tool_use_id: m.tool_call_id,
        content: blocks, ...(m.tool_state === 'error' ? { is_error: true } : {})
      };
      const previous = native.at(-1);
      if (previous?.role === 'user' && previous.content?.every?.((b) => b.type === 'tool_result')) {
        previous.content.push(result);
      } else native.push({ role: 'user', content: [result] });
      continue;
    }
    if (m.role === 'assistant') {
      // 原生思考块带签名；工具调用后的下一轮必须原样回传。
      if (Array.isArray(m.anthropic_content)) {
        native.push({ role: 'assistant', content: m.anthropic_content });
        continue;
      }
      const blocks = m.content ? contentBlocks(m.content, allowImages) : [];
      for (const tc of m.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: toolInput(tc.function?.arguments) });
      }
      if (blocks.length) native.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'user') native.push({ role: 'user', content: contentBlocks(m.content, allowImages) });
  }
  return { system: system.filter(Boolean).join('\n\n'), messages: native };
}

function nativeUsage(raw) {
  if (!raw) return null;
  const input = Number(raw.input_tokens) || 0;
  const cacheRead = Number(raw.cache_read_input_tokens) || 0;
  const cacheCreate = Number(raw.cache_creation_input_tokens) || 0;
  return {
    prompt_tokens: input + cacheRead + cacheCreate,
    completion_tokens: Number(raw.output_tokens) || 0,
    cached_tokens: cacheRead
  };
}

function nativeResult(blocks, usage, { onDelta, onThinking } = {}) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      message.content += clean(block.text);
      if (onDelta && block.text) onDelta(block.text);
    } else if (block.type === 'thinking' && block.thinking && onThinking) {
      onThinking(block.thinking);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id, type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      });
    }
  }
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
    // 包括签名思考块、文本和 tool_use；下次请求原样回传给 Claude。
    message.anthropic_content = blocks;
  }
  if (!message.content && !toolCalls.length) throw new Error('Claude 返回空响应');
  return { message, usage: nativeUsage(usage) };
}

function nativeStream(res, { signal, onDelta, onThinking }) {
  return (async () => {
    const blocks = new Map();
    const usage = {};
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];
    let stopped = false;
    function handleEvent() {
      if (!dataLines.length) return;
      const raw = dataLines.join('\n');
      dataLines = [];
      let event;
      try { event = JSON.parse(raw); }
      catch { throw new Error('Claude 流式响应包含无法解析的事件'); }
      if (event.type === 'error') throw new Error(`Claude 流式错误：${event.error?.message || event.error?.type || '未知错误'}`);
      if (event.type === 'message_start') Object.assign(usage, event.message?.usage);
      if (event.type === 'message_delta') Object.assign(usage, event.usage);
      if (event.type === 'message_stop') stopped = true;
      if (event.type === 'content_block_start') {
        const block = { ...event.content_block };
        blocks.set(event.index, block);
        if (block.type === 'text' && block.text) onDelta?.(block.text);
        if (block.type === 'thinking' && block.thinking) onThinking?.(block.thinking);
      }
      if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (!block) return;
        const delta = event.delta || {};
        if (delta.type === 'text_delta') {
          block.text = (block.text || '') + delta.text;
          if (delta.text) onDelta?.(delta.text);
        } else if (delta.type === 'thinking_delta') {
          block.thinking = (block.thinking || '') + delta.thinking;
          if (delta.thinking) onThinking?.(delta.thinking);
        } else if (delta.type === 'signature_delta') {
          block.signature = (block.signature || '') + delta.signature;
        } else if (delta.type === 'input_json_delta') {
          block._partialJson = (block._partialJson || '') + delta.partial_json;
        }
      }
      if (event.type === 'content_block_stop') {
        const block = blocks.get(event.index);
        if (block?.type === 'tool_use' && block._partialJson) {
          try { block.input = JSON.parse(block._partialJson); }
          catch { throw new Error(`Claude 工具 ${block.name || ''} 返回了不完整的 JSON 参数`); }
          delete block._partialJson;
        }
      }
    }
    function acceptLine(line) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) handleEvent();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          acceptLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer) acceptLine(buffer);
      handleEvent();
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
      throw error;
    } finally { reader.releaseLock(); }
    if (!stopped) throw new Error('Claude 流式响应意外中断');
    return nativeResult([...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block), usage);
  })();
}

export async function anthropicCompletion(client, { messages, tools, signal, onDelta, onThinking }) {
  const converted = toNativeMessages(messages, client.vision !== false);
  const body = {
    model: client.model,
    max_tokens: 8192,
    stream: true,
    messages: converted.messages
  };
  if (converted.system) body.system = converted.system;
  if (tools?.length && client.supportsTools !== false) {
    body.tools = tools.filter((t) => t.type === 'function' && t.function?.name).map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} }
    }));
    if (body.tools.length) body.tool_choice = { type: 'auto' };
    else delete body.tools;
  }
  const adaptive = /^claude-(?:(?:opus|sonnet)-(?:4-[6-9](?:[.-]|$)|[5-9](?:[.-]|$))|(?:fable|mythos)-)/i.test(client.model);
  const alwaysThinking = /^claude-(?:opus-5-5(?:[.-]|$)|fable-|mythos-)/i.test(client.model);
  if (client.thinking) {
    if (adaptive) body.thinking = { type: 'adaptive' };
    else if (/^claude-(?:3-7|(?:opus|sonnet|haiku)-4-[0-5])(?:[.-]|$)/i.test(client.model)) {
      body.thinking = { type: 'enabled', budget_tokens: 2048 };
    }
  } else if (adaptive && !alwaysThinking) body.thinking = { type: 'disabled' };
  if (adaptive) body.output_config = { effort: client.thinking === false ? 'low' :
    (['low', 'medium', 'high'].includes(client.thinkingEffort) ? client.thinkingEffort : 'high') };
  if (client.temperature != null && !body.thinking) body.temperature = Math.max(0, Math.min(1, Number(client.temperature)));

  let res;
  try {
    res = await fetch(client.baseURL + '/messages', {
      method: 'POST', signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': client.apiKey
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
    throw new Error(`无法连接 Claude 服务 ${client.baseURL}（${error.message}）`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const raw = (await res.text()).slice(0, 800);
      try { const parsed = JSON.parse(raw); detail = String(parsed.error?.message || parsed.message || raw); }
      catch { detail = raw; }
    } catch { /* 无错误正文 */ }
    if ((res.status === 400 || res.status === 422) && /tool/i.test(detail)) {
      const error = new Error(`Claude 不支持当前工具调用：${detail.slice(0, 300)}`);
      error.code = 'TOOL_UNSUPPORTED';
      throw error;
    }
    throw new Error(`Claude API 错误 ${res.status}${detail ? `：${detail.slice(0, 400)}` : ''}`);
  }
  const contentType = res.headers?.get?.('content-type') || '';
  if (/text\/event-stream/i.test(contentType)) return nativeStream(res, { signal, onDelta, onThinking });
  // 某些代理会忽略 stream:true；保持与原适配器相同的 JSON 兜底。
  let json;
  try { json = await res.json(); }
  catch { throw new Error('Claude API 返回了无法解析的响应'); }
  return nativeResult(json.content || [], json.usage, { onDelta, onThinking });
}
