import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8791';
let passed = 0;
const ok = label => { passed++; console.log('通过：' + label); };
async function request(path, token, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
const admin = (path, body) => request(path, 'local-test-admin', body);
const user = (path, body) => request(path, 'local-user-one', body);
assert.equal((await request('/admin/users', 'local-user-one')).status, 401); ok('普通账户无法访问管理接口');
assert.equal((await request('/admin/presence', 'local-user-one')).status, 401); ok('在线人数仅管理员可查询');
assert.equal((await request('/admin/messages', 'wrong', { userId: null, title: 'x', body: 'x' })).status, 401); ok('无效管理密钥无法发消息');
assert.equal((await admin('/admin/users')).status, 200); ok('管理员可查询账户');
assert.equal((await admin('/admin/users?q=' + 'long-email-'.repeat(15) + '%40example.invalid')).status, 200); ok('长邮箱搜索不依赖 LIKE 模式限制');
const ticket = await user('/account/events-ticket', {});
assert.equal(ticket.status, 200);
const socket = new WebSocket(base.replace('http:', 'ws:') + '/account/events?ticket=' + encodeURIComponent(ticket.data.ticket));
const events = [];
socket.addEventListener('message', event => { if (event.data !== 'pong') events.push(JSON.parse(event.data)); });
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
async function waitPresence(users, connections) {
  const until = Date.now() + 3000;
  let snapshot;
  while (Date.now() < until) {
    const response = await admin('/admin/presence');
    assert.equal(response.status, 200);
    snapshot = response.data;
    if (snapshot.onlineUsers === users && snapshot.connections === connections) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.deepEqual({ users: snapshot?.onlineUsers, connections: snapshot?.connections }, { users, connections });
}
const moreSockets = [];
await waitPresence(1, 1);
ok('登录账户建立实时连接后在线人数立即更新');
async function waitEvent(type, action) {
  events.length = 0;
  const result = await action();
  assert.equal(result.status, 200, JSON.stringify(result));
  const until = Date.now() + 3000;
  while (!events.some(e => e.type === type) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
  assert.ok(events.some(e => e.type === type), '缺少事件 ' + type);
  return result;
}
try {
  for (const token of ['local-user-one', 'local-user-two']) {
    const nextTicket = await request('/account/events-ticket', token, {});
    assert.equal(nextTicket.status, 200);
    const extra = new WebSocket(base.replace('http:', 'ws:') + '/account/events?ticket=' + encodeURIComponent(nextTicket.data.ticket));
    await new Promise((resolve, reject) => { extra.addEventListener('open', resolve, { once: true }); extra.addEventListener('error', reject, { once: true }); });
    moreSockets.push(extra);
  }
  await waitPresence(2, 3);
  ok('同一账户多连接去重，不同账户分别计数');
  moreSockets.pop().close();
  await waitPresence(1, 2);
  ok('用户断线后在线人数回落');
  await waitEvent('message-received', () => admin('/admin/messages', { userId: 900001, title: '定向消息', body: '正文 <script>不得执行</script>' }));
  const inbox = await user('/account/messages');
  const message = inbox.data.messages.find(m => m.title === '定向消息');
  assert.ok(message); assert.ok(inbox.data.unread > 0); ok('定向消息持久化并实时推送');
  const other = await request('/account/messages', 'local-user-two');
  assert.ok(!other.data.messages.some(m => m.id === message.id));
  await request('/account/messages/read', 'local-user-two', { ids: [message.id] });
  assert.equal((await user('/account/messages')).data.messages.find(m => m.id === message.id).read_at, null); ok('消息列表和已读操作隔离账户');
  await waitEvent('messages-changed', () => user('/account/messages/read', { ids: [message.id] }));
  assert.ok((await user('/account/messages')).data.messages.find(m => m.id === message.id).read_at); ok('标记已读及实时同步');
  await waitEvent('account-changed', () => admin('/admin/users/900001/ban', { banned: true, reason: '测试封禁' }));
  assert.equal((await user('/auth/me')).data.banned, true);
  assert.equal((await user('/models')).status, 403);
  assert.equal((await user('/asr/v1/audio/transcriptions', {})).status, 403);
  assert.equal((await user('/account/events-ticket', {})).status, 200); ok('封禁立即推送并阻止模型和语音服务，保留恢复通道');
  await waitEvent('account-changed', () => admin('/admin/users/900001/ban', { banned: false }));
  assert.equal((await user('/auth/me')).data.banned, false);
  assert.equal((await user('/models')).status, 200); ok('同一会话即时解封，无需重新登录');
  await waitEvent('message-received', () => admin('/admin/messages', { userId: null, title: '广播测试', body: '所有账户' }));
  assert.ok((await request('/account/messages', 'local-user-two')).data.messages.some(m => m.title === '广播测试')); ok('广播持久化至全部账户');
  for (const path of ['/auth/credits', '/official/models', '/plans']) assert.equal((await user(path)).status, 404);
  ok('已移除服务保持 404');
  console.log(`${passed} 项管理与实时测试通过`);
} finally {
  for (const extra of moreSockets) extra.close();
  socket.close();
  await admin('/admin/users/900001/ban', { banned: false });
}
