import { redact } from '../security.js';

export function resultPreview(result, limit, archive) {
  if (result.result.length <= limit) return result;
  const text = redact(result.result);
  if (text.length <= limit) return { ...result, result: text };
  let id = null;
  if (result.meta?.failure?.kind !== 'hook-denied') {
    try { id = archive.save(text); } catch { /* The preview still works when local storage fails. */ }
  }
  const marker = id
    ? `\n… [共 ${text.length} 字符；用 ToolOutput 读取中间内容，id: ${id}] …\n`
    : `\n… [共 ${text.length} 字符；中间内容已截断] …\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.floor(available * 0.7);
  const tail = available - head;
  const preview = text.slice(0, head).replace(/[\uD800-\uDBFF]$/, '') + marker +
    (tail ? text.slice(-tail).replace(/^[\uDC00-\uDFFF]/, '') : '');
  return {
    ...result, result: preview,
    meta: { ...result.meta, ...(id && { tool_output_id: id }), output_chars: text.length, output_truncated: true },
  };
}

export function createToolOutputReader(archive, maxChars) {
  return {
    name: 'ToolOutput',
    requiresWorkspace: false,
    description: '按 ID 和字符偏移读取当前会话已截断的工具文本。ID 来自工具结果，偏移从 0 开始。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工具输出返回的 ID' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['id'],
    },
    execute({ id, offset = 0, limit = 3000 }) {
      const text = archive.read(id);
      if (text === null) {
        return { ok: false, text: '该输出在当前会话不可用。', meta: { failure: { kind: 'output-not-found', retryable: false } } };
      }
      const start = Math.min(offset, text.length);
      const requested = Math.min(limit, maxChars - 150);
      let end = Math.min(start + requested, text.length);
      if (/[\uDC00-\uDFFF]/.test(text.charAt(end))) end += end === start + 1 ? 1 : -1;
      const chunk = text.slice(start, end).replace(/^[\uDC00-\uDFFF]/, '').replace(/[\uD800-\uDBFF]$/, '');
      return `ToolOutput ${id} · ${start}–${end}/${text.length}${end < text.length ? ` · 下一页 offset=${end}` : ''}\n${chunk}`;
    },
  };
}
