// Tool definitions and the execution boundary shared by ordinary, ReAct and review calls.
// Policy and hooks are supplied by the Agent so a denial cannot be bypassed by a tool.
export function createToolRegistry(tools, canonicalName) {
  const byName = new Map();
  for (const tool of tools) {
    if (!tool?.name || typeof tool.execute !== 'function') throw new TypeError('Invalid tool definition');
    const alias = canonicalName(tool.name).toLowerCase();
    if (byName.has(tool.name) || byName.has(alias)) throw new Error(`工具名重复: ${tool.name}`);
    byName.set(tool.name, tool);
    byName.set(alias, tool);
  }

  return {
    definitions: tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    })),
    async invoke(call, args, context) {
      const started = Date.now();
      const name = call.function?.name;
      const canonical = canonicalName(name);
      const tool = byName.get(name) || byName.get(canonical.toLowerCase());
      let ok = true;
      let value;
      try {
        if (!tool) {
          ok = false;
          value = `未知工具: ${name}`;
        } else if (!context.cwd && canonical !== 'WebFetch' && canonical !== 'WebSearch') {
          ok = false;
          value = '工具不可用：未选择工作目录。请先在会话顶部点击「选择文件夹」。';
        } else if (context.signal?.aborted) {
          ok = false;
          value = '已中止：用户停止了本次回复。';
        } else {
          value = await tool.execute(args, context);
          if (['Write', 'Edit'].includes(canonical) && typeof value === 'string') ok = false;
          if (canonical === 'Bash' && typeof value === 'string') {
            const exitCode = /\bexit_code:\s*(-?\d+|null)\b/.exec(value)?.[1];
            if (exitCode !== '0' || /^(?:命令已被用户中止|命令超时|命令输出超过)/.test(value)) ok = false;
          }
          if (value && typeof value === 'object' && value.ok === false) ok = false;
        }
      } catch (error) {
        ok = false;
        value = `工具执行异常: ${error?.message || error}`;
      }
      let image = null;
      let meta = null;
      if (value && typeof value === 'object') {
        image = value.image || null;
        meta = value.meta && typeof value.meta === 'object' ? value.meta : null;
        value = value.text ?? JSON.stringify(value);
      }
      return { ok, result: String(value ?? ''), image, meta, durationMs: Date.now() - started };
    }
  };
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
