import { validateAgainstSchema } from './schema-validator.js';

// Tool definitions and the execution boundary shared by ordinary, ReAct and review calls.
// Policy and hooks are supplied by the Agent so a denial cannot be bypassed by a tool.
export function createToolRegistry(tools, canonicalName) {
  const byName = new Map();
  const definitions = [];
  const find = (name) => byName.get(name) || byName.get(canonicalName(name).toLowerCase());
  function register(tool) {
    if (!tool?.name || typeof tool.execute !== 'function') throw new TypeError('Invalid tool definition');
    const alias = canonicalName(tool.name).toLowerCase();
    if (byName.has(tool.name) || byName.has(alias)) throw new Error(`工具名重复: ${tool.name}`);
    byName.set(tool.name, tool);
    byName.set(alias, tool);
    const definition = { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
    definitions.push(definition);
    return definition;
  }
  tools.forEach(register);

  return {
    definitions,
    register,
    has: (name) => Boolean(find(name)),
    async invoke(call, args, context, beforeExecute) {
      const started = Date.now();
      const name = call.function?.name;
      const canonical = canonicalName(name);
      const tool = find(name);
      let ok = true;
      let value;
      let failure = null;
      try {
        if (!tool) {
          ok = false;
          value = `未知工具: ${name}`;
          failure = { kind: 'unknown-tool', retryable: false };
        } else if (!context.cwd && toolRequiresWorkspace(tool)) {
          ok = false;
          value = '工具不可用：未选择工作目录。请先在会话顶部点击「选择文件夹」。';
          failure = { kind: 'requires-workspace', retryable: false };
        } else if (context.signal?.aborted) {
          ok = false;
          value = '已中止：用户停止了本次回复。';
          failure = { kind: 'aborted', retryable: false };
        } else {
          const objectInput = args !== null && typeof args === 'object' && !Array.isArray(args);
          // External MCP schemas can exceed the local validator's supported subset.
          const validation = !objectInput ? { ok: false, errors: ['工具参数必须是 JSON 对象'] }
            : name.startsWith('mcp__') ? { ok: true } : validateAgainstSchema(args, tool.parameters);
          if (!validation.ok) {
            ok = false;
            value = `工具参数无效：${validation.errors.join('；')}`;
            failure = { kind: 'invalid-arguments', retryable: false };
          } else {
            beforeExecute?.();
            value = await tool.execute(args, context);
            if (['Write', 'Edit'].includes(canonical) && typeof value === 'string') ok = false;
            if (['Bash', 'Git'].includes(canonical) && typeof value === 'string') {
              const exitCode = /\bexit_code:\s*(-?\d+|null)\b/.exec(value)?.[1];
              if (exitCode !== '0' || /^(?:命令已被用户中止|命令超时|命令输出超过)/.test(value)) ok = false;
              if (canonical === 'Bash' && value.startsWith('命令执行结果未知。')) {
                failure = { kind: 'execution-unknown', retryable: false };
              }
            }
            if (value && typeof value === 'object' && value.ok === false) ok = false;
          }
        }
      } catch (error) {
        ok = false;
        value = `工具执行异常: ${error?.message || error}`;
      }
      let image = null;
      let meta = failure ? { failure } : null;
      if (value && typeof value === 'object') {
        image = value.image || null;
        meta = { ...(value.meta && typeof value.meta === 'object' ? value.meta : {}), ...(meta || {}) };
        if (!Object.keys(meta).length) meta = null;
        value = value.text ?? JSON.stringify(value);
      }
      return { ok, result: String(value ?? ''), image, meta, durationMs: Date.now() - started };
    }
  };
}

export function toolRequiresWorkspace(tool) {
  return tool.requiresWorkspace !== false && tool.name !== 'WebFetch' && tool.name !== 'WebSearch';
}

/** The same ordered, deny-first path is used for every Agent tool call. */
export async function runToolPipeline({ call, args, before, invoke, after, denied }) {
  let decision;
  try {
    decision = await before(call, args);
  } catch (error) {
    return { ok: false, result: `工具执行前检查异常: ${error?.message || error}`, image: null, meta: null, durationMs: 0 };
  }
  if (decision?.behavior !== 'allow') {
    try { return denied(decision ?? { behavior: 'deny', noChannel: true }, call, args); }
    catch (error) { return { ok: false, result: `工具拒绝结果异常: ${error?.message || error}`, image: null, meta: null, durationMs: 0 }; }
  }
  const effectiveArgs = decision.args ?? args;
  let result;
  try { result = await invoke(call, effectiveArgs); }
  catch (error) { return { ok: false, result: `工具执行异常: ${error?.message || error}`, image: null, meta: null, durationMs: 0 }; }
  if (!after) return result;
  try {
    return await after(call, effectiveArgs, result);
  } catch (error) {
    return { ...result, ok: false, result: `工具执行后检查异常: ${error?.message || error}\n\n原始结果：\n${result.result}` };
  }
}
