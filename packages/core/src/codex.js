// Codex uses Responses, not Chat Completions. Keep the Agent's existing result contract.
import { contextLengthError, modelFetch, modelConnectionError, readModelResponse } from './model-transport.js';
import { sanitizeLoneSurrogates, normalizeUsage } from './model.js';
import { CODEX_BASE_URL, CODEX_PROVIDER, getCodexAuth, codexHeaders, codexHttpError, assertCodexConnection } from './codex-auth.js';

const clean = value => sanitizeLoneSurrogates(String(value ?? ''));
const aborted = () => Object.assign(new Error('已中止'), { code: 'ABORTED' });
const streamError = message => Object.assign(new Error(message), { code: 'CODEX_STREAM_ERROR' });
const upstreamMessage = body => {
  const message = body?.error?.message || body?.message || (typeof body?.detail === 'string' ? body.detail : '');
  return typeof message === 'string' ? message : '';
};
const publicMessage = message => {
  const text = message.replace(/\s+/g, ' ').trim().slice(0, 180);
  return text && !/bearer|sk-|eyJ|token|oauth/i.test(text) ? text : '';
};

export function codexRequestBody(client, messages, tools) {
  const input = [], instructions = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push(Array.isArray(message.content) ? message.content.map(part => clean(part.text)).join('\n') : clean(message.content));
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: clean(message.content) });
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.role === 'assistant') {
      for (const item of message.tora_response_items || []) {
        if (item?.tora_provider !== CODEX_PROVIDER || item.tora_connection_id !== client.codexConnectionId || item.tora_model !== client.model) continue;
        if (item.type === 'reasoning' && typeof item.id === 'string' && typeof item.encrypted_content === 'string') input.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: (item.summary || []).filter(part => part.type === 'summary_text' && typeof part.text === 'string').map(part => ({ type: 'summary_text', text: clean(part.text) })) });
      }
    }
    const textType = message.role === 'assistant' ? 'output_text' : 'input_text';
    const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    const content = parts.flatMap(part => {
      if (part?.type === 'image_url') {
        if (!client.vision) return [{ type: textType, text: '[图片附件已省略：当前模型不支持视觉输入]' }];
        return [{ type: 'input_image', image_url: part.image_url.url }];
      }
      const text = clean(part?.text);
      return text ? [{ type: textType, text }] : [];
    });
    if (content.length) input.push({ role: message.role, content });
    for (const call of message.tool_calls || []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: clean(call.function.arguments || '{}') });
  }
  const efforts = client.codexEfforts || ['low', 'medium', 'high'];
  const desired = client.thinking ? client.thinkingEffort : 'none';
  const effort = efforts.includes(desired) ? desired : desired === 'low' && efforts.includes('minimal') ? 'minimal' : desired === 'max' || desired === 'xhigh' ? efforts.at(-1) : client.thinking ? (efforts.includes('high') ? 'high' : efforts.at(-1)) : efforts[0];
  return {
    model: client.model, instructions: instructions.join('\n\n'), input,
    tools: client.supportsTools === false ? [] : (tools || []).map(tool => ({ type: 'function', name: tool.function.name, ...(tool.function.description ? { description: tool.function.description } : {}), parameters: tool.function.parameters, strict: false })),
    tool_choice: 'auto', parallel_tool_calls: true, stream: true, store: false,
    include: ['reasoning.encrypted_content'], reasoning: { effort, summary: 'auto' },
    ...(client.promptCacheKey ? { prompt_cache_key: client.promptCacheKey } : {}),
  };
}

export async function codexCompletion(client, { messages, tools, signal, onDelta, onThinking }) {
  if (signal?.aborted) throw aborted();
  assertCodexConnection(client.codexConnectionId);
  const body = JSON.stringify(codexRequestBody(client, messages, tools));
  let auth = await getCodexAuth({ signal });
  const send = async () => {
    assertCodexConnection(client.codexConnectionId);
    try {
      return await modelFetch(`${CODEX_BASE_URL}/responses`, {
        method: 'POST', headers: { ...codexHeaders(auth), 'content-type': 'application/json', accept: 'text/event-stream' },
        body, signal, redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw aborted();
      throw modelConnectionError('Codex', CODEX_BASE_URL, error);
    }
  };
  let response = await send();
  if (response.status === 401) {
    await response.body?.cancel();
    auth = await getCodexAuth({ force: true, signal });
    response = await send();
  }
  if (!response.ok) {
    if ([400, 413, 422].includes(response.status)) {
      const detail = await response.text().catch(() => '');
      const lengthError = contextLengthError(response.status, detail.slice(0, 1000));
      if (lengthError) throw lengthError;
    } else await response.body?.cancel();
    throw codexHttpError(response.status);
  }
  if (!response.body) throw streamError('Codex 未返回有效的流式响应');
  let completed = false, usage = null;
  const message = { role: 'assistant', content: '' };
  const calls = new Map(), finalItems = new Map(), indices = new Map();
  const remember = (item, index) => {
    const previousKey = item.type === 'function_call' && item.call_id ? [...calls].find(([, call]) => call.id === item.call_id)?.[0] : undefined;
    const key = previousKey || item.id || item.call_id || String(index);
    if (index !== undefined) indices.set(index, key);
    finalItems.set(key, item);
    if (item.type !== 'function_call') return;
    let call = calls.get(key);
    if (!call) { call = { id: item.call_id || '', type: 'function', function: { name: item.name || '', arguments: '' } }; calls.set(key, call); }
    if (item.call_id) call.id = item.call_id;
    if (item.name) call.function.name = item.name;
    if (typeof item.arguments === 'string') call.function.arguments = item.arguments;
  };
  const processEvent = event => {
    if (completed) return;
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta === 'string') { message.content += event.delta; onDelta?.(event.delta); }
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta === 'string') { message.reasoning_content = (message.reasoning_content || '') + event.delta; onThinking?.(event.delta); }
    } else if (['response.output_item.added', 'response.output_item.done'].includes(event.type) && event.item) {
      remember(event.item, event.output_index);
    } else if (event.type === 'response.function_call_arguments.delta') {
      const call = calls.get(event.item_id || indices.get(event.output_index) || String(event.output_index));
      if (!call || typeof event.delta !== 'string') throw streamError('Codex 工具调用格式无效');
      call.function.arguments += event.delta;
    } else if (event.type === 'response.function_call_arguments.done') {
      const call = calls.get(event.item_id || indices.get(event.output_index) || String(event.output_index));
      if (call && typeof event.arguments === 'string') call.function.arguments = event.arguments;
    } else if (event.type === 'response.completed') {
      if (event.response?.status && event.response.status !== 'completed') throw streamError('Codex 回复未完成');
      for (const [index, item] of (event.response?.output || []).entries()) remember(item, index);
      const items = [...finalItems.values()];
      if (!message.content) {
        const text = items.filter(item => item.type === 'message').flatMap(item => item.content || []).map(part => part.text || part.refusal || '').join('');
        if (text) { message.content = text; onDelta?.(text); }
      }
      if (!message.reasoning_content) {
        const text = items.filter(item => item.type === 'reasoning').flatMap(item => item.summary || []).map(part => part.text || '').join('');
        if (text) { message.reasoning_content = text; onThinking?.(text); }
      }
      message.tora_response_items = items.filter(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string').map(item => ({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: item.summary || [], tora_provider: CODEX_PROVIDER, tora_connection_id: client.codexConnectionId, tora_model: client.model }));
      const raw = event.response?.usage;
      if (raw) usage = normalizeUsage({ prompt_tokens: raw.input_tokens, completion_tokens: raw.output_tokens, total_tokens: raw.total_tokens ?? (raw.input_tokens || 0) + (raw.output_tokens || 0), prompt_tokens_details: raw.input_tokens_details, completion_tokens_details: raw.output_tokens_details });
      completed = true;
    } else if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
      throw streamError('Codex 回复失败或未完成，请重试或检查订阅额度');
    }
  };
  try {
    for await (const frame of readModelResponse(response, signal)) {
      let event = frame.data;
      if (frame.format === 'json') {
        const isResponse = event?.object === 'response' || event?.type === 'response' || Array.isArray(event?.output);
        if (!isResponse) throw streamError(publicMessage(upstreamMessage(event)) || 'Codex 未返回有效的流式响应');
        event = { type: 'response.completed', response: event };
      }
      processEvent(event);
      if (completed) break;
    }
    if (signal?.aborted) throw aborted();
    if (!completed) throw streamError('Codex 流式响应中断，回复未完成');
    assertCodexConnection(client.codexConnectionId);
    if (calls.size) message.tool_calls = [...calls.values()].map(call => {
      try {
        const args = JSON.parse(call.function.arguments);
        if (!call.id || !call.function.name || !args || typeof args !== 'object' || Array.isArray(args)) throw Error();
      } catch { throw streamError('Codex 工具调用参数不完整，已停止执行'); }
      return call;
    });
    message.content = clean(message.content);
    if (!message.content && !message.tool_calls?.length) throw streamError('Codex 返回空响应');
    return { message, usage };
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (error.code === 'CODEX_STREAM_ERROR' || error.code === 'CODEX_REAUTH_REQUIRED') throw error;
    throw streamError('Codex 流式响应中断，回复未完成');
  }
}
