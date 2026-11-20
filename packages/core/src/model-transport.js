// 桌面端注入 Electron 网络栈，以继承系统代理；CLI 默认使用 Node fetch。
// 不自动重试生成请求：连接中断时上游可能已经接收并计费。
let modelFetcher = null;

export function setModelFetcher(fetcher) {
  if (fetcher != null && typeof fetcher !== 'function') throw new TypeError('模型请求器必须是函数');
  modelFetcher = fetcher ?? null;
}

export function modelFetch(url, init) {
  return (modelFetcher ?? globalThis.fetch)(url, init);
}

export function contextLengthError(status, detail) {
  if (![400, 413, 422].includes(status)) return null;
  const pattern = /context_length_exceeded|context_window_exceeded|prompt (?:is )?too long|maximum context length|(?:exceeds?|exceeded) (?:the )?(?:model'?s? )?(?:maximum )?context (?:length|window)|context (?:length|window) (?:is )?(?:exceeded|too (?:large|long))/i;
  if (!pattern.test(detail)) return null;
  return Object.assign(new Error('请求超过模型的上下文长度上限'), { code: 'CONTEXT_LENGTH' });
}

// Some gateways mislabel SSE as JSON or omit Content-Type; sniff only the prefix, never buffer a stream to EOF.
export async function* readModelResponse(response, signal) {
  const aborted = () => Object.assign(new Error('已中止'), { code: 'ABORTED' });
  const invalid = () => new Error('模型服务返回了无效的流式或 JSON 响应');
  if (signal?.aborted) throw aborted();
  if (!response.body) throw invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const limit = 2 * 1024 * 1024, prefixes = ['data:', 'event:', ':', 'id:', 'retry:'];
  let format, buffer = '', data = [], size = 0, skipLF = false;
  const parse = text => { try { return JSON.parse(text); } catch { throw invalid(); } };
  const consume = line => {
    if (!line) {
      const payload = data.join('\n'); data = []; size = 0;
      return payload;
    }
    if (line === 'data' || line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      size += value.length + 1;
      if (size > limit) throw invalid();
      data.push(value);
    }
    return '';
  };
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw aborted();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw aborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (!format) {
        if (buffer.length > limit) throw invalid();
        const prefix = buffer.trimStart();
        if (prefix[0] === '{' || prefix[0] === '[') { format = 'json'; buffer = prefix; }
        else if (prefixes.some(field => prefix.startsWith(field))) { format = 'sse'; buffer = prefix; }
        else if (prefix && (done || !prefixes.some(field => field.startsWith(prefix)))) throw invalid();
      }
      if (format === 'sse') {
        if (skipLF && buffer) {
          if (buffer[0] === '\n') buffer = buffer.slice(1);
          skipLF = false;
        }
        let end;
        while ((end = buffer.search(/[\r\n]/)) >= 0) {
          const line = buffer.slice(0, end);
          skipLF = buffer[end] === '\r' && end === buffer.length - 1;
          const length = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
          buffer = buffer.slice(end + length);
          const payload = consume(line);
          if (!payload) continue;
          if (payload.trim() === '[DONE]') return;
          yield { format, data: parse(payload) };
        }
      }
      if (buffer.length > limit) throw invalid();
      if (done) break;
    }
    if (format === 'json') { yield { format, data: parse(buffer) }; return; }
    if (!format) throw invalid();
    if (buffer) consume(buffer);
    const payload = consume('');
    if (payload && payload.trim() !== '[DONE]') yield { format, data: parse(payload) };
  } catch (error) {
    if (signal?.aborted) throw aborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function modelConnectionError(service, baseURL, cause) {
  // 仅展示稳定错误代码，不回显可能包含凭证的底层错误正文。
  const code = cause?.cause?.code ?? cause?.code;
  const detail = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `，${code}` : '';
  return new Error(`无法连接${service} ${baseURL}（网络请求失败${detail}）。请稍后重试或检查网络连接。`, { cause });
}
