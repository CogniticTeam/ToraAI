// ASAPI 协议层：AgentEvent 工厂 + Msg 构建 + 内部(OpenAI) ⇄ display(Msg[]) 转换
// 协议契约来自 @agentscope-ai/agentscope SDK（event/message 类型 + appendEvent 归并语义），
// 前端 useMessages.ts 依赖 REPLY_START 建 Msg、appendEvent 增量归并、REPLY_END 收尾。
import { uid } from './store.js';

const now = () => new Date().toISOString();
const ev = (obj) => ({ id: uid(), created_at: now(), ...obj });

export const E = {
  replyStart: (session_id, reply_id, name = 'assistant') =>
    ev({ type: 'REPLY_START', session_id, reply_id, name, role: 'assistant' }),
  replyEnd: (session_id, reply_id, finished_reason, error = null) =>
    ev({ type: 'REPLY_END', session_id, reply_id, finished_reason, error }),
  modelCallStart: (reply_id, model_name) =>
    ev({ type: 'MODEL_CALL_START', reply_id, model_name }),
  modelCallEnd: (reply_id, input_tokens, output_tokens) =>
    ev({ type: 'MODEL_CALL_END', reply_id, input_tokens, output_tokens }),
  textBlockStart: (reply_id, block_id) =>
    ev({ type: 'TEXT_BLOCK_START', reply_id, block_id }),
  textBlockDelta: (reply_id, block_id, delta) =>
    ev({ type: 'TEXT_BLOCK_DELTA', reply_id, block_id, delta }),
  textBlockEnd: (reply_id, block_id) =>
    ev({ type: 'TEXT_BLOCK_END', reply_id, block_id }),
  // 深度思考：形状与 text 块完全一致（SDK appendEvent 直接归并成 thinking 块）
  thinkingBlockStart: (reply_id, block_id) =>
    ev({ type: 'THINKING_BLOCK_START', reply_id, block_id }),
  thinkingBlockDelta: (reply_id, block_id, delta) =>
    ev({ type: 'THINKING_BLOCK_DELTA', reply_id, block_id, delta }),
  thinkingBlockEnd: (reply_id, block_id) =>
    ev({ type: 'THINKING_BLOCK_END', reply_id, block_id }),
  toolCallStart: (reply_id, tool_call_id, tool_call_name) =>
    ev({ type: 'TOOL_CALL_START', reply_id, tool_call_id, tool_call_name }),
  toolCallDelta: (reply_id, tool_call_id, delta) =>
    ev({ type: 'TOOL_CALL_DELTA', reply_id, tool_call_id, delta }),
  toolCallEnd: (reply_id, tool_call_id) =>
    ev({ type: 'TOOL_CALL_END', reply_id, tool_call_id }),
  toolResultStart: (reply_id, tool_call_id, tool_call_name) =>
    ev({ type: 'TOOL_RESULT_START', reply_id, tool_call_id, tool_call_name }),
  toolResultTextDelta: (reply_id, tool_call_id, delta) =>
    ev({ type: 'TOOL_RESULT_TEXT_DELTA', reply_id, tool_call_id, delta }),
  toolResultEnd: (reply_id, tool_call_id, state, metadata) =>
    ev({ type: 'TOOL_RESULT_END', reply_id, tool_call_id, state, ...(metadata ? { metadata } : {}) }),
  /**
   * 权限询问（HITL）：把待确认的工具调用交给前端渲染成确认卡片。
   * 前端 appendEvent 会把对应 tool_call 块置为 state='asking' 并带上
   * suggested_rules —— ConfirmCard 就是从这两个字段渲染"以后都允许"选项的。
   */
  requireUserConfirm: (reply_id, tool_calls) =>
    ev({ type: 'REQUIRE_USER_CONFIRM', reply_id, tool_calls }),
  custom: (name, value) =>
    ev({ type: 'CUSTOM', name, value })
};

/** 构造 REQUIRE_USER_CONFIRM 需要的 tool_call 块 */
export function askingToolCall({ id, name, args, suggestedRules }) {
  return {
    type: 'tool_call',
    id,
    name,
    input: JSON.stringify(args ?? {}),
    state: 'asking',
    suggested_rules: suggestedRules || [],
    created_at: now(),
    finished_at: null
  };
}

// ---------- Msg 构建（历史接口直接返回 display 数组） ----------
/**
 * @param {string} text
 * @param {object} [metadata] 前端用来渲染附件气泡的额外信息（目前只有
 *   ``selected_skill_ids``）。必须落盘：否则刷新页面后 useMessages 重新拉
 *   历史时 metadata 为空，用户气泡上的技能 chip 会凭空消失。
 */
export function userMsg(text, metadata, extraBlocks) {
  const t = now();
  const content = [{ type: 'text', id: uid(), text, created_at: t, finished_at: t }];
  // 附件块（如图片 data block）：追加在文本后，前端按同样形态渲染气泡
  for (const b of Array.isArray(extraBlocks) ? extraBlocks : []) {
    if (b && typeof b === 'object' && b.type) content.push(b);
  }
  return {
    id: uid(), name: 'user', role: 'user',
    content,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    created_at: t, finished_at: t
  };
}

/**
 * 系统提示消息（会话时间线内的中性事件条，如「模型已从 X 更改为 Y」）。
 * role=system：前端按分隔条样式渲染，不进 LLM internal 上下文。
 */
export function systemNoticeMsg(text, metadata) {
  const t = now();
  return {
    id: uid(), name: 'system', role: 'system',
    content: [{ type: 'text', id: uid(), text, created_at: t, finished_at: t }],
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    created_at: t, finished_at: t
  };
}

export function assistantMsgShell(reply_id) {
  return {
    id: reply_id, name: 'assistant', role: 'assistant',
    content: [], metadata: {}, created_at: now(), finished_at: null
  };
}

/**
 * 本次运行的增量（internal OpenAI 格式）→ display Msg[]（一条 user + 一条 assistant）。
 * assistant Msg 按 agentscope 语义归并：text 块 + tool_call 块 + tool_result 块同属一条回复。
 */
export function deltaToMsgs(delta, reply_id) {
  const out = [];
  const userTexts = [];
  const blocks = [];
  for (const m of delta) {
    if (m.role === 'user') {
      userTexts.push(typeof m.content === 'string' ? m.content : '');
    } else if (m.role === 'assistant') {
      const t = now();
      if (m.content) {
        blocks.push({ type: 'text', id: uid(), text: m.content, created_at: t, finished_at: t });
      }
      for (const tc of m.tool_calls || []) {
        blocks.push({
          type: 'tool_call', id: tc.id, name: tc.function?.name || '',
          input: tc.function?.arguments || '{}',
          state: 'finished', created_at: t, finished_at: t
        });
      }
    } else if (m.role === 'tool') {
      const t = now();
      blocks.push({
        type: 'tool_result', id: m.tool_call_id, name: m.tool_name || '',
        output: [{ type: 'text', id: uid(), text: m.content ?? '', created_at: t, finished_at: t }],
        state: m.tool_state === 'error' ? 'error' : 'success',
        metadata: m.tool_metadata,
        created_at: t, finished_at: t
      });
    }
  }
  for (const text of userTexts) out.push(userMsg(text));
  if (blocks.length) {
    const msg = assistantMsgShell(reply_id);
    msg.content = blocks;
    msg.finished_at = now();
    out.push(msg);
  }
  return out;
}

/** display Msg[] → OpenAI 消息数组（不含 system；system 由 agent 注入） */
export function msgsToOpenAI(display) {
  const out = [];
  for (const m of display) {
    if (m.role === 'user') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const toolCalls = m.content.filter((b) => b.type === 'tool_call');
      const out2 = { role: 'assistant', content: text };
      if (toolCalls.length) {
        out2.tool_calls = toolCalls.map((tc) => ({
          id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.input }
        }));
      }
      out.push(out2);
      for (const trb of m.content.filter((b) => b.type === 'tool_result')) {
        const text = Array.isArray(trb.output)
          ? trb.output.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
          : String(trb.output ?? '');
        out.push({ role: 'tool', tool_call_id: trb.id, content: text });
      }
    }
  }
  return out;
}

// ---------- SessionView / Msg 视图裁剪 ----------
export function toSessionView(record, status) {
  const { internal, display, ...session } = record;
  session.state = { ...(record.state || {}) };
  return {
    session,
    is_running: status === 'running',
    status: status || 'idle',
    team: null
  };
}

/** 用户输入 Msg（ContentBlock[]）→ 纯文本 */
export function inputToText(input) {
  if (!input || typeof input !== 'object') return '';
  const content = Array.isArray(input.content) ? input.content : [];
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
