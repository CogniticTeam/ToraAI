// 显式线上验收：只操作随机创建的测试账户，finally 删除本次测试数据。
// COCODE_LIVE_TEST=1 COCODE_ADMIN_ACCESS_FILE=/path/to/private-access.txt node scripts/test-account-live.mjs
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (process.env.COCODE_LIVE_TEST !== '1' || !process.env.COCODE_ADMIN_ACCESS_FILE) throw new Error('请显式启用线上验收并指定管理凭证文件');
const key = readFileSync(process.env.COCODE_ADMIN_ACCESS_FILE, 'utf8').match(/管理密钥：([^\n]+)/)?.[1];
if (!key) throw new Error('管理凭证文件无效');
const base = 'https://cocode.ohfun.online';
const id = randomUUID().replaceAll('-', '');
const email = `cocode-acceptance-${id}@example.invalid`;
const token = randomBytes(48).toString('hex');
let socket;
const sql = statement => JSON.parse(execFileSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'cocode-auth', '--remote', '--config', 'packages/auth-worker/wrangler.toml', '--json', '--command', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
async function request(path, auth, body) {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  return { status: r.status, data: await r.json() };
}
try {
  assert.equal((await fetch(base + '/health')).status, 200);
  const legacy = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), 'https://ohfun.online/admin');
  const panel = await fetch('https://ohfun.online/admin');
  assert.equal(panel.status, 200); assert.ok((await panel.text()).includes('CoCode 管理后台'));
  assert.equal((await request('/admin/users', 'invalid')).status, 401);
  sql(`INSERT INTO users (email,username,salt,hash,created_at) VALUES ('${email}','qa-${id.slice(0,20)}','${randomBytes(16).toString('hex')}','${randomBytes(32).toString('hex')}','${new Date().toISOString()}'); INSERT INTO sessions(token,user_id,expires_at) SELECT '${token}',id,${Date.now()+600000} FROM users WHERE email='${email}';`);
  const users = await request('/admin/users?q=' + encodeURIComponent(email), key);
  assert.equal(users.status, 200, JSON.stringify(users)); assert.equal(users.data.users.length, 1);
  const userId = users.data.users[0].id;
  const ticket = await request('/account/events-ticket', token, {});
  assert.equal(ticket.status, 200);
  const events = [];
  socket = new WebSocket(base.replace('https:', 'wss:') + '/account/events?ticket=' + ticket.data.ticket);
  socket.addEventListener('message', event => events.push(JSON.parse(event.data)));
  await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(Error('WebSocket 连接超时')),15000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('WebSocket 连接失败'))},{once:true}); });
  async function mutation(path, body, type) {
    events.length=0;
    const start=Date.now();
    const r=await request(path,key,body);assert.equal(r.status,200,JSON.stringify(r));
    const deadline=Date.now()+5000;
    while(!events.some(event=>event.type===type)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
    assert.ok(events.some(event=>event.type===type), '未收到实时事件');
    return Date.now()-start;
  }
  await mutation('/admin/messages',{userId,title:'CoCode 部署验收',body:'仅测试账户可见，测试完成后删除。'},'message-received');
  const inbox=await request('/account/messages',token);assert.equal(inbox.data.unread,1);
  await request('/account/messages/read',token,{ids:[inbox.data.messages[0].id]});
  assert.equal((await request('/account/messages',token)).data.unread,0);
  const banMs=await mutation(`/admin/users/${userId}/ban`,{banned:true,reason:'自动验收'},'account-changed');
  assert.equal((await request('/models',token)).status,403);
  assert.equal((await request('/auth/me',token)).data.banned,true);
  const unbanMs=await mutation(`/admin/users/${userId}/ban`,{banned:false},'account-changed');
  assert.equal((await request('/models',token)).status,200);
  assert.equal((await request('/auth/me',token)).data.banned,false);
  console.log(`线上验证通过：后台鉴权、消息发送/已读、WebSocket 推送、封禁 ${banMs} ms、解封 ${unbanMs} ms、同一会话恢复。`);
} finally {
  socket?.close();
  sql(`DELETE FROM account_messages WHERE user_id IN (SELECT id FROM users WHERE email='${email}'); DELETE FROM account_tickets WHERE user_id IN (SELECT id FROM users WHERE email='${email}'); DELETE FROM admin_audit WHERE user_id IN (SELECT id FROM users WHERE email='${email}'); DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email='${email}'); DELETE FROM users WHERE email='${email}';`);
  console.log('本次线上测试账户及消息已清理。');
}
