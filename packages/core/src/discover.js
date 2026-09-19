// 本地模型自动发现：扫常见本地推理服务的默认端口，自动给出可用的
// baseURL + 模型名，省去用户手抄配置。
//
// 覆盖：Ollama(11434) / LM Studio(1234) / vLLM(8000) / llama.cpp server(8080) /
// text-generation-webui(5000)。全部走 127.0.0.1，短超时（本地没起就该立刻返回）。

const CANDIDATES = [
  { kind: 'ollama', label: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', probe: 'ollama' },
  { kind: 'lmstudio', label: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', probe: 'openai' },
  { kind: 'vllm', label: 'vLLM / SGLang', baseURL: 'http://127.0.0.1:8000/v1', probe: 'openai' },
  { kind: 'llamacpp', label: 'llama.cpp server', baseURL: 'http://127.0.0.1:8080/v1', probe: 'openai' },
  { kind: 'textgen', label: 'text-generation-webui', baseURL: 'http://127.0.0.1:5000/v1', probe: 'openai' }
];

async function probeOne(cand, timeout) {
  const signal = AbortSignal.timeout(timeout);
  try {
    if (cand.probe === 'ollama') {
      const res = await fetch(cand.baseURL.replace('/v1', '') + '/api/tags', { signal });
      if (!res.ok) return null;
      const body = await res.json();
      const models = (body?.models || []).map((m) => m.name || m.model).filter(Boolean);
      if (!models.length) return null;
      return { ...cand, models };
    }
    const res = await fetch(cand.baseURL + '/models', { signal });
    if (!res.ok) return null;
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body?.data ?? body?.models ?? []);
    const models = list.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean);
    if (!models.length) return null;
    return { ...cand, models };
  } catch {
    return null;
  }
}

/**
 * 并发探测所有候选端口。
 * @returns {Promise<Array<{kind,label,baseURL,models:string[]}>>}
 */
export async function discoverLocalModels({ timeout = 800 } = {}) {
  const results = await Promise.all(CANDIDATES.map((c) => probeOne(c, timeout)));
  return results.filter(Boolean);
}
