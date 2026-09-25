/**
 * 主窗口只能停留在 CoCode 本地服务；外链仅交给系统浏览器处理。
 * 保持为纯 Node 模块，方便不启动 Electron GUI 也能做回归测试。
 */
export function isAppUrl(raw, appOrigin) {
  try {
    return new URL(raw).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

export function normalizeExternalHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('外部链接不是合法 URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`外部链接协议不被允许：${url.protocol || 'unknown'}`);
  }
  return url.toString();
}
