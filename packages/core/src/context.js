// 低 token 上下文管理：估算 → 驱逐旧工具输出 → 必要时摘要压缩
// 策略（自下而上逐级触发，尽量少丢信息、少花 token）：
//  1. 估算超出预算时，先把较旧 tool 消息的 content 替换为占位符（保留最近 4 条完整）
//  2. 仍超预算时，把历史压缩为一条摘要（需一次模型调用；失败则硬截断兜底）

/** 粗略估算字符串 token 数：CJK 约 1 字/ token，ASCII 约 4 字符/token */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 0.9 + rest / 3.8);
}

/** 多模态 content（parts 数组）→ 只取文本部分，图像按固定开销计 */
function contentTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) {
    let t = 0;
    for (const part of content) {
      if (part?.type === 'text') t += estimateTokens(part.text ?? '');
      else if (part?.type === 'image_url') t += 1100; // 视觉输入的粗估（分辨率相关）
    }
    return t;
  }
  return 16;
}

/** 多模态 content → 可读文本（供摘要/展示用；绝不把 base64 带进去） */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p?.type === 'text' ? (p.text ?? '') : `[${p?.type ?? 'block'}]`)).join('\n');
  }
  return content == null ? '' : String(content);
}

export function estimateMessagesTokens(messages) {
  let t = 0;
  for (const m of messages) {
    t += 4;
    t += contentTokens(m.content);
    if (m.tool_calls) for (const tc of m.tool_calls) t += estimateTokens(tc.function?.name) + estimateTokens(tc.function?.arguments);
  }
  return t;
}

/**
 * 驱逐旧的工具输出。返回 { messages, evicted }（不修改原数组）。
 * 规则：tool 角色消息按时间顺序（保留最近 keepRecent 条），content 换成占位摘要。
 */
export function evictToolOutputs(messages, budget, keepRecent = 4) {
  const total = estimateMessagesTokens(messages);
  if (total <= budget) return { messages, evicted: 0 };
  const toolIdx = [];
  messages.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
  const evictable = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  const next = messages.map((m) => ({ ...m }));
  let evicted = 0;
  for (const i of evictable) {
    if (estimateMessagesTokens(next) <= budget) break;
    const c = next[i].content;
    if (typeof c === 'string' && !c.startsWith('[已驱逐')) {
      const head = c.slice(0, 80).replace(/\n/g, ' ');
      next[i].content = `[已驱逐以省 token] 原输出约 ${c.length} 字符，开头: ${head}`;
      evicted++;
    } else if (Array.isArray(c)) {
      // 多模态工具结果（图片 + 文本）：驱逐时连图一起丢掉，只留文本开头
      const t = contentToText(c);
      if (t.startsWith('[已驱逐')) continue;
      next[i].content = `[已驱逐以省 token（含图像输入）] 原输出约 ${t.length} 字符，开头: ${t.slice(0, 80).replace(/\n/g, ' ')}`;
      evicted++;
    }
  }
  return { messages: next, evicted };
}

/**
 * 摘要压缩：把 messages[keepHead .. -keepTail] 压缩成一条摘要。
 * @param summarize async (prompt) => string  由调用方注入模型调用
 * @param minMiddleTokens 中段小于此值就不值得花一次模型调用去摘要
 *   （摘要本身有固定开销：提示词 + 纪要前缀 + 纪要正文）。默认 400。
 */
export async function compactMessages(messages, { budget, summarize, keepHead = 1, keepTail = 6, minMiddleTokens = 400 }) {
  if (messages.length <= keepHead + keepTail) return { messages, compacted: false };
  const total = estimateMessagesTokens(messages);
  if (total <= budget) return { messages, compacted: false };
  const head = messages.slice(0, keepHead);
  const tail = messages.slice(-keepTail);
  const middle = messages.slice(keepHead, -keepTail);
  // 中段太小 → 摘要前缀本身就比它长，压完反而更费 token，直接跳过。
  if (estimateMessagesTokens(middle) < minMiddleTokens) {
    return { messages, compacted: false };
  }
  const digest = middle.map((m) => {
    const who = m.role === 'tool' ? 'TOOL_RESULT' : m.role.toUpperCase();
    let body = contentToText(m.content);
    if (m.role === 'tool') body = body.slice(0, 300); // 工具结果在摘要里更激进地截断
    if (m.tool_calls) body = m.tool_calls.map((tc) => `${tc.function?.name}(${(tc.function?.arguments || '').slice(0, 200)})`).join('; ');
    return `[${who}] ${body.slice(0, 600)}`;
  }).join('\n').slice(0, 12000);

  let summary;
  try {
    summary = await summarize(
      '请用中文把以下对话过程压缩为一份高密度纪要（保留：任务目标、已完成的操作与文件路径、关键结论、未决事项）。直接输出纪要正文，不要任何寒暄：\n\n' + digest
    );
  } catch {
    // 模型调用失败 → 硬截断兜底
    summary = `[上下文超限，已硬截断 ${middle.length} 条历史消息]`;
  }
  const compactedMsg = {
    role: 'system',
    content: `[会话纪要（自动压缩，替代更早的历史）]\n${summary}`
  };
  return { messages: [...head, compactedMsg, ...tail], compacted: true };
}
