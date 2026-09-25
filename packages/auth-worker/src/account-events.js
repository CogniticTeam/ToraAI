// 仅由已鉴权的 Worker 路由调用。每个连接使用用户 ID 标签，支持休眠。
export class AccountEvents {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/publish' && request.method === 'POST') {
      const { userId, event } = await request.json();
      const sockets = userId == null ? this.ctx.getWebSockets() : this.ctx.getWebSockets(String(userId));
      let delivered = 0;
      for (const socket of sockets) {
        try { socket.send(JSON.stringify(event)); delivered++; }
        catch { try { socket.close(1011, 'Reconnect'); } catch { /* 连接已关闭。 */ } }
      }
      return Response.json({ delivered });
    }
    if (path !== '/connect' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not Found', { status: 404 });
    }
    const userId = request.headers.get('X-Account-Id');
    if (!userId) return new Response('Unauthorized', { status: 401 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [userId]);
    pair[1].serializeAttachment({ expiresAt: Number(request.headers.get('X-Session-Expires')) });
    pair[1].send(JSON.stringify({ type: 'ready' }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket, message) {
    if (socket.deserializeAttachment().expiresAt <= Date.now()) {
      socket.close(1008, 'Session expired');
      return;
    }
    if (message === 'ping') socket.send('pong');
  }
  webSocketClose(socket) {
    // 浏览器未提供状态码时事件可能是保留值 1005，不能原样回写给 close。
    try { socket.close(1000, 'Closed'); } catch { /* 连接已经完全关闭。 */ }
  }
  webSocketError(socket) { try { socket.close(1011, 'Reconnect'); } catch { /* 连接已关闭。 */ } }
}

export async function publishAccountEvent(env, userId, event) {
  const hub = env.ACCOUNT_EVENTS.get(env.ACCOUNT_EVENTS.idFromName('accounts'));
  const response = await hub.fetch('https://internal/publish', {
    method: 'POST', body: JSON.stringify({ userId, event }),
  });
  if (!response.ok) throw new Error('实时推送失败');
  return response.json();
}
