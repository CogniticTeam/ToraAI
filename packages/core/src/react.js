// 文本 ReAct 降级：给不支持 function calling 的模型用的动作解析
//
// 背景：agent.js 原来是 `if (!message.tool_calls?.length) return done()` ——
// 接入的模型一旦不支持 tool_calls，整个 Agent 直接失效，只会输出纯文本然后结束。
// 而项目卖点是「任何 OpenAI 兼容接口」，这条必须补。
//
// 协议：模型输出 ```json {"tool":"Read","args":{...}} ``` 表示要调工具，
// 输出 {"final": "..."} 或无 JSON 块表示最终答复。

/**
 * 从平衡括号的角度切出第一个完整 JSON 对象（考虑字符串与转义）。
 * 比 `/\{[\s\S]*\}/` 稳：不会把后面的散文吞进来。
 */
function sliceBalancedJson(text, startIdx) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function tryParse(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

/**
 * 解析模型输出里的动作。
 * @returns {{tool:string, args:object}|{final:string}|null}
 *   null = 没有可识别的动作（调用方按"最终答复"处理）
 */
export function parseReactAction(content) {
  const text = String(content ?? '');
  if (!text.trim()) return null;

  // 1) 优先 fenced code block（```json / ```）
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text))) {
    const obj = tryParse(m[1].trim());
    if (obj) {
      const norm = normalizeAction(obj);
      if (norm) return norm;
    }
  }

  // 2) 退化：找第一个平衡的 {...}（可能模型没加围栏）
  let idx = text.indexOf('{');
  while (idx >= 0) {
    const sliced = sliceBalancedJson(text, idx);
    if (sliced) {
      const obj = tryParse(sliced);
      const norm = obj ? normalizeAction(obj) : null;
      if (norm) return norm;
      idx = text.indexOf('{', idx + 1);
    } else break;
  }
  return null;
}

/** 把各种写法归一化成 {tool,args} / {final} */
function normalizeAction(obj) {
  if (typeof obj.final === 'string' || typeof obj.answer === 'string') {
    return { final: obj.final ?? obj.answer };
  }
  // {"tool": "Read", "args": {...}} / {"action": "Read", "input": {...}}
  const tool = obj.tool ?? obj.action ?? obj.name ?? obj.tool_name;
  if (typeof tool !== 'string' || !tool.trim()) return null;
  let args = obj.args ?? obj.arguments ?? obj.input ?? obj.parameters ?? {};
  if (typeof args === 'string') args = tryParse(args) ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { tool: tool.trim(), args };
}

/**
 * 极简平衡块解析（导出给测试用）
 */
export const __sliceBalancedJson = sliceBalancedJson;
