// CoCode 模型接入层：任何 OpenAI 兼容 Chat Completions 接口
// 零依赖实现：fetch + 手写 SSE 解析，支持流式与工具调用聚合
//
// 能力探测：部分 OpenAI 兼容接口并不实现 function calling（一些小模型网关、
// 老版本 vLLM 等）。首次发送 tools 撞到 400/422 且错误信息提到 tool/function
// 时，记下"该端点不支持工具调用"，后续降级为文本 ReAct（见 agent.js）。
// 缓存 key 是 baseURL + model，进程内共享。
const toolSupport = new Map();

const capabilityKey = (cfg) => `${String(cfg?.baseURL || '').replace(/\/+$/, '')}|${cfg?.model || ''}`;

export function getToolSupport(cfg) {
  return toolSupport.get(capabilityKey(cfg)) ?? true;
}

export function markToolUnsupported(cfg) {
  toolSupport.set(capabilityKey(cfg), false);
}

export function markToolSupported(cfg) {
  toolSupport.set(capabilityKey(cfg), true);
}

/** 仅测试用：清空能力缓存 */
export function resetToolSupportCache() {
  toolSupport.clear();
}

export const SYSTEM_PROMPT = `Your name is CoCode (product name: CoCode). You are a highly capable AI coding and task-execution agent embedded in a terminal/desktop tool. You complete as much work as possible while keeping token consumption minimal. You excel at coding, code review, refactoring, writing, and answering questions. You routinely make appropriate use of Skills and invoke them as frequently as needed.
You prioritize breaking down complex user requests into actionable subtasks and carry them out in order, avoiding redundant verbiage and useless deliberation. Prefer acting over asking: inspect the repository (Glob/Grep/RepoMap) before proposing changes. Use the minimal edit that achieves the goal (Edit over Write) and always verify your work by running the relevant test or build command with Bash. Your outputs go straight to the point: deliver usable results first, not vague ideas. When information is insufficient, ask one concise question about the key parameter instead of guessing.
You keep changes reviewable: show diffs before overwriting, avoid touching files unrelated to the task, and never hide failures. You respect the repository's own conventions (see project instructions when present) over your personal defaults. You are honest about what you did and did not verify.`;


/**
 * 常见支持视觉输入的模型名（用于决定要不要把图片作为 image_url 发出）。
 * 注意：
 *  - Anthropic 新命名（claude-sonnet-4-5 / claude-opus-4-1）不含 "claude-3"/"claude-4"
 *    子串，必须按档位词（opus/sonnet/haiku）匹配；
 *  - o1-mini / o3-mini 是纯文本，要用负向前瞻排除；
 *  - 名字含 vision / multimodal 的直接兜底，其余按家族精确匹配，
 *    避免误放纯文本变体（如 doubao-pro、grok-3、kimi-k2、qwq、glm-4.6）。
 */
const VISION_MODEL_RE = /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1(?!-mini)|o3(?!-mini)|o4|claude-(?:[3-9]|opus|sonnet|haiku)|gemini|gemma-3|qwen[\d.]*[-_]?vl|qvq|deepseek-vl|doubao-seed|seed-1\.[56]|kimi-(?:latest|vl|vision)|vision|multimodal|llava|minicpm-v|internvl|pixtral|grok-4|grok.*vision|step-1[vo]|glm-4v|glm-\d\.\dv|ernie.*vl|molmo|cogvlm)/i;

export function detectVision(cfg) {
  if (cfg?.vision === true) return true;
  if (cfg?.vision === false) return false;
  return VISION_MODEL_RE.test(String(cfg?.model || ''));
}

export function createClient(cfg) {
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseURL)) {
    throw new Error('未配置 apiKey：请运行 `vega config` 或设置 VEGA_API_KEY（本地模型如 Ollama 可免鉴权）');
  }
  return {
    baseURL: cfg.baseURL.replace(/\/+$/, ''),
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTurns: cfg.maxTurns ?? 40,
    // 能力位：tool_calls 由探测结果决定；vision 由模型名/配置推断
    supportsTools: cfg.forceReact ? false : getToolSupport(cfg),
    vision: detectVision(cfg),
    // prompt cache：稳定前缀 + 由厂商自动缓存（DeepSeek/智谱）时无需额外字段；
    // 需要显式声明的端点可用 promptCacheKey 传稳定键。
    promptCacheKey: cfg.promptCacheKey ?? null,
    // 深度思考：默认**开启**（用户显式关掉才关，parameters.thinking === false）。
    // 请求参数按端点自适应换挡（见 chatCompletion），解析对 reasoning_content /
    // reasoning 两种增量字段都生效。thinkingEffort 仅对 reasoning_effort 档生效。
    thinking: cfg.thinking !== false,
    thinkingEffort: typeof cfg.thinkingEffort === 'string' ? cfg.thinkingEffort : 'high',
    // structured output：v1 全部走 prompt 强制 + 解析重试，不依赖原生 JSON Schema
    supportsJsonSchema: false,
    // 任务模式（WorkBuddy 式差异化计费）：ask=轻问答 / craft=Agent 任务。
    // 经 X-CoCode-Mode 头上送网关计费，缺省 craft（Agent 编码为主场景）。
    mode: String(cfg.mode || '').toLowerCase() === 'ask' ? 'ask' : 'craft'
  };
}

/**
 * 把字符串里的 lone surrogate（孤立的高位或低位代理码元）替换为 U+FFFD。
 *
 * 严格的 JSON 解析器（如部分 LLM 上游的 serde_json / Python json 严格模式）
 * 不允许字符串里出现未配对的 surrogate code unit，会报"unexpected end of
 * hex escape"或"lone surrogate"。本函数把这种情况归一化为 FFFD，模型可
 * 安全识别为"此处原本有字符但被破坏"，不会误解语义。
 *
 * 触发场景：LLM 流式输出 emoji 等 BMP 外字符时，delta 边界切到 surrogate
 * pair 中间（`message.content += delta.content` 拼接），留下半截字符，
 * 被持久化进 session，下次发送时撞上上游严格解析器。
 */
export function sanitizeLoneSurrogates(s) {
	if (typeof s !== 'string' || !s.length) return s;
	if (!/[\uD800-\uDFFF]/.test(s)) return s;
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const cp = s.charCodeAt(i);
		if (cp >= 0xD800 && cp <= 0xDBFF) {
			const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
			if (next >= 0xDC00 && next <= 0xDFFF) {
				out += s[i] + s[i + 1];
				i++;
				continue;
			}
			out += '\uFFFD';
		} else if (cp >= 0xDC00 && cp <= 0xDFFF) {
			out += '\uFFFD';
		} else {
			out += s[i];
		}
	}
	return out;
}

/**
 * 归一化 usage：各家对"命中缓存"的字段名不同（DeepSeek 用
 * prompt_cache_hit_tokens，OpenAI 用 prompt_tokens_details.cached_tokens，
 * Anthropic 风格用 cache_read_input_tokens）。统一暴露 cached_tokens，
 * 方便前端/CLI 显示"这次省了多少"。
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cached = u.prompt_cache_hit_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? u.cache_read_input_tokens
    ?? 0;
  return {
    ...u,
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    cached_tokens: Number(cached) || 0
  };
}

/**
 * 调用 chat/completions。返回 { message, usage }。
 * @param {ReturnType<typeof createClient>} client
 * @param {{messages:Array, tools?:Array, signal?:AbortSignal, onDelta?:(text:string)=>void}} opts
 */
/** 深度思考参数的端点档位缓存：`${baseURL}|${model}` → 'enable_thinking' | 'reasoning_effort' | 'none' */
const thinkingParamCache = new Map();

export async function chatCompletion(client, { messages, tools, signal, onDelta, onThinking }) {
	// 只发送 API 标准字段（内部元数据如 tool_name 不上送）。
	// content 支持两种形态：纯字符串，或多模态 parts 数组（[{type:'text'}, {type:'image_url'}]）。
	// 文本部分 / tool_calls.arguments / name 都过一遍 sanitizeLoneSurrogates，
	// 修掉 LLM 流式拼接偶尔留下的半截 emoji，否则上游严格解析器会报 400。
	const wire = messages.map((m) => {
		let content = Array.isArray(m.content)
			? m.content.map((part) => (part?.type === 'text' ? { ...part, text: sanitizeLoneSurrogates(part.text ?? '') } : part))
			: sanitizeLoneSurrogates(m.content);
		// 保险丝：确认不支持视觉的模型（vision === false），剥掉历史里的
		// image_url part，否则上游报 400 崩掉整轮。剥完后若数组空掉，
		// 补一条占位文本避免「空 content」。
		if (client.vision === false && Array.isArray(content)) {
			const kept = content.filter((part) => part?.type !== 'image_url');
			if (kept.length < content.length) {
				const hadText = kept.some((part) => part?.type === 'text');
				content = hadText ? kept : [...kept, { type: 'text', text: '[图片附件已省略：当前模型不支持视觉输入]' }];
			}
		}
		const out = { role: m.role, content };
		if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
		if (m.tool_calls) {
			out.tool_calls = m.tool_calls.map((tc) => ({
				...tc,
				function: {
					...tc.function,
					arguments: sanitizeLoneSurrogates(tc.function?.arguments ?? ''),
				},
			}));
		}
		if (m.name) out.name = sanitizeLoneSurrogates(m.name);
		return out;
	});
  const baseBody = {
    model: client.model,
    messages: wire
  };
  // 深度思考参数各家约定不一：Qwen/DashScope/vLLM 认 enable_thinking，
  // OpenAI o 系认 reasoning_effort，DeepSeek R1 这类根本不需要参数。
  // 策略：按已缓存的可用档位尝试，被 400/422 拒就换下一档（结果缓存，
  // 同一端点后续请求直接用对的那一档）。
  const thinkingKey = `${client.baseURL}|${client.model}`;
  const thinkingVariants = [
    { key: 'enable_thinking', extra: { enable_thinking: true } },
    { key: 'reasoning_effort', extra: { reasoning_effort: client.thinkingEffort === 'max' ? 'high' : (client.thinkingEffort ?? 'high') } },
    { key: 'none', extra: {} }
  ];
  const knownVariant = thinkingParamCache.get(thinkingKey);
  if (knownVariant) thinkingVariants.sort((a, b) => (a.key === knownVariant ? -1 : 1));
  const thinkingVariantsForClient = client.thinking ? thinkingVariants : [{ key: 'none', extra: {} }];
  // 已知不支持 tool_calls 的端点：不再带 tools，省一次必然失败的往返
  const toolsEnabled = !!tools?.length && client.supportsTools !== false;
  if (toolsEnabled) {
    baseBody.tools = tools;
    baseBody.tool_choice = 'auto';
  }
  if (client.temperature != null) baseBody.temperature = client.temperature;
  if (client.promptCacheKey) baseBody.prompt_cache_key = client.promptCacheKey;

  // 强制流式输出：所有模型一律 stream:true，不做自动降级（用户明确要求）。
  // 端点若不支持流式会直接报错暴露，而不是悄悄退回非流式。
  outer: for (;;) {
    const body = { ...baseBody, stream: true, stream_options: { include_usage: true } };

    let res;
    // 思考参数逐档尝试：被 400/422 拒（未知参数等）就换下一档，最后一档仍失败
    // 才按普通错误上报。非 thinking 请求只有一档，行为与从前完全一致。
    for (const variant of thinkingVariantsForClient) {
      const reqBody = { ...body, ...variant.extra };
      let detail = '';
      try {
        res = await fetch(client.baseURL + '/chat/completions', {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            ...(client.apiKey ? { authorization: `Bearer ${client.apiKey}` } : {}),
            // 任务模式声明（ask|craft），网关按模式倍率差异化计费；非官方端点会忽略此头
            'x-cocode-mode': client.mode || 'craft'
          },
          body: JSON.stringify(reqBody)
        });
      } catch (e) {
        if (signal?.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
        throw new Error(`无法连接模型服务 ${client.baseURL}（${e.message}）。检查 baseURL / 网络 / 代理设置。`);
      }

      if (res.ok) {
        // 这一档能用，缓存起来 —— 同一端点后续请求直接用对的那档
        if (client.thinking) thinkingParamCache.set(thinkingKey, variant.key);
        break;
      }
      try { detail = (await res.text()).slice(0, 400); } catch { /* ignore */ }
      // 端点压根不支持 function calling → 记下能力，交给 agent 降级为文本 ReAct
      if (toolsEnabled && (res.status === 400 || res.status === 422 || res.status === 500)
        && /tool|function[_ ]?call/i.test(detail)) {
        const err = new Error(`模型 ${client.model} 不支持工具调用（HTTP ${res.status}）：${detail.slice(0, 200)}`);
        err.code = 'TOOL_UNSUPPORTED';
        throw err;
      }
      // 思考参数被拒：换下一档（'none' 是最后一档，走到它就不会再 continue 了）
      if (client.thinking && variant.key !== 'none' && (res.status === 400 || res.status === 422)) {
        const next = thinkingVariants[thinkingVariants.indexOf(variant) + 1];
        thinkingParamCache.set(thinkingKey, next?.key ?? 'none');
        continue;
      }
      const hint = {
        401: 'API Key 无效或未授权',
        403: '无权限访问该模型',
        404: '接口路径或模型不存在（检查 baseURL 是否以 /v1 结尾）',
        429: '请求过于频繁或额度不足'
      }[res.status];
      // 上游返回 JSON 时只展示其 message（如网关 402 订阅引导、OpenAI error.message），
      // 不倾倒原始响应体；解析不出才回退原文。业务 code 挂到 err 供前端区分引导。
      let shown = detail;
      let bizCode = '';
      try {
        const j = JSON.parse(detail);
        const msg = j?.message || j?.error?.message || j?.detail?.message;
        if (msg) {
          shown = String(msg);
          bizCode = String(j?.code || j?.error?.code || '');
        }
      } catch { /* 非 JSON 响应体，保持原文 */ }
      const err = new Error(hint ? `模型服务错误 ${res.status}：${hint}（${shown}）` : shown);
      if (bizCode) err.code = bizCode;
      throw err;
    }

    // 有些端点对 stream:true 不报错、直接回一整份 JSON —— 按 content-type
    // 识别，走一次性 JSON 解析，不然 SSE 解析器一行 data: 都找不到。
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (/text\/event-stream|stream/i.test(contentType)) {
      // ---- SSE 流解析 ----
      const message = { role: 'assistant', content: '' };
      const toolCalls = new Map(); // index -> {id, type:'function', function:{name, arguments}}
      let usage = null;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.usage) usage = normalizeUsage(ev.usage);
          const choice = ev.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          // 深度思考增量：DeepSeek/Qwen 用 reasoning_content，OpenRouter 等用 reasoning。
          // 只上屏、不进 history —— 绝大多数端点不接受 reasoning_content 回传。
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning) onThinking?.(reasoning);
          if (delta.content) {
            message.content += delta.content;
            onDelta?.(delta.content);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!toolCalls.has(i)) toolCalls.set(i, { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } });
              const cur = toolCalls.get(i);
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.function.name += tc.function.name;
              if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            }
          }
        }
      }

      if (toolCalls.size) {
        message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      }
      if (!message.content && !message.tool_calls?.length) {
        throw new Error('模型返回空响应（可能被内容过滤或模型异常）');
      }
      return { message, usage };
    }

    // ---- 一次性 JSON（端点无视 stream 参数静默回完整响应时的兜底解析）----
    let json;
    try {
      json = await res.json();
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('已中止'), { code: 'ABORTED' });
      throw new Error(`模型服务返回了无法解析的响应（${e.message}）`);
    }
    const msg = json.choices?.[0]?.message ?? {};
    const message = { role: 'assistant', content: typeof msg.content === 'string' ? sanitizeLoneSurrogates(msg.content) : '' };
    // 非流式的思考内容一次性到达，同样只上屏不进 history
    const reasoning = msg.reasoning_content ?? msg.reasoning;
    if (typeof reasoning === 'string' && reasoning) onThinking?.(reasoning);
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      message.tool_calls = msg.tool_calls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        type: 'function',
        function: {
          name: tc.function?.name ?? '',
          arguments: sanitizeLoneSurrogates(tc.function?.arguments ?? '')
        }
      }));
    }
    const usage = normalizeUsage(json.usage);
    if (!message.content && !message.tool_calls?.length) {
      throw new Error('模型返回空响应（可能被内容过滤或模型异常）');
    }
    return { message, usage };
  }
}
