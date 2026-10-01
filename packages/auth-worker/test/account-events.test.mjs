import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountEvents, snapshotAccountPresence } from '../src/account-events.js';

test('在线人数按有效 WebSocket 的用户 ID 去重，连接数单独统计', async () => {
  const now = Date.now();
  const sockets = [
    { readyState: 1, deserializeAttachment: () => ({ expiresAt: now + 60_000 }) },
    { readyState: 1, deserializeAttachment: () => ({ expiresAt: now + 120_000 }) },
    { readyState: 1, deserializeAttachment: () => ({ expiresAt: now + 180_000 }) },
    { readyState: 3, deserializeAttachment: () => ({ expiresAt: now + 180_000 }) },
    { readyState: 1, deserializeAttachment: () => ({ expiresAt: now - 1 }) },
  ];
  const tags = ['1', '1', '2', '3', '4'];
  const ctx = { getWebSockets: () => sockets, getTags: (socket) => [tags[sockets.indexOf(socket)]] };
  assert.deepEqual(snapshotAccountPresence(ctx, now), { onlineUsers: 2, connections: 3, sampledAt: new Date(now).toISOString() });
  const hub = new AccountEvents(ctx, {});
  const response = await hub.fetch(new Request('https://internal/presence'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).onlineUsers, 2);
});

test('客户端无 close 状态码或异常断线时不回写保留状态码', () => {
  const hub = new AccountEvents({}, {});
  for (const incoming of [1000, 1005, 1006, 1015]) {
    let closed = false;
    hub.webSocketClose({ close(code) {
      assert.ok(![1005, 1006, 1015].includes(code));
      closed = true;
    } }, incoming, '');
    assert.ok(closed);
  }
});
test('已关闭连接不会使推送至其他连接失败', async () => {
  const sent = [];
  const hub = new AccountEvents({ getWebSockets: () => [
    { send() { throw new Error('closed'); }, close() { throw new Error('closed'); } },
    { send(data) { sent.push(JSON.parse(data)); } },
  ] }, {});
  const response = await hub.fetch(new Request('https://internal/publish', {
    method: 'POST', body: JSON.stringify({ userId: 1, event: { type: 'account-changed' } }),
  }));
  assert.equal((await response.json()).delivered, 1);
  assert.equal(sent[0].type, 'account-changed');
});
