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

export function modelConnectionError(service, baseURL, cause) {
  // 仅展示稳定错误代码，不回显可能包含凭证的底层错误正文。
  const code = cause?.cause?.code ?? cause?.code;
  const detail = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `，${code}` : '';
  return new Error(`无法连接${service} ${baseURL}（网络请求失败${detail}）。请稍后重试或检查网络连接。`, { cause });
}
