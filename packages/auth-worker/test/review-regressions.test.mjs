import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { handleAdminPoll } from '../src/polls.js';

// Match Wrangler's text imports without starting a worker or accessing production.
registerHooks({ load(url, context, next) {
  if (/\.(html|sql)$/.test(url)) return { format: 'module', shortCircuit: true,
    source: `export default ${JSON.stringify(readFileSync(new URL(url), 'utf8'))}` };
  return next(url, context);
} });

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const DB = { prepare(sql) {
    const statement = args => ({
      bind: (...values) => statement(values),
      first: async () => sqlite.prepare(sql).get(...args) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => { const result = sqlite.prepare(sql).run(...args); return { meta: { ...result, last_row_id: Number(result.lastInsertRowid) } }; },
    });
    return statement([]);
  }, exec: async sql => sqlite.exec(sql), async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, DB };
}
const request = (path, data) => new Request('https://fixture.invalid' + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
});

test('批量删除只删除所选且已过期的投票，单选、混合选择和归档顺序正确', async t => {
  const { sqlite, DB } = database(); t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY);');
  sqlite.exec(readFileSync(new URL('../migrations/0001_polls.sql', import.meta.url), 'utf8'));
  const now = Date.now();
  const add = (id, end) => sqlite.prepare("INSERT INTO polls(id,start_at,end_at,status,created_at,updated_at) VALUES(?,?,?,'published',?,?)").run(id, now - 10000, end, now, now);
  add('single', now - 1); add('expired-one', now - 1); add('future-one', now + 86400000); add('expired-last', now - 1); add('not-selected', now - 1);
  const invoke = async (ids, action = 'delete-expired') => {
    const req = request('/admin/polls/bulk', { ids, action });
    return (await handleAdminPoll(req, { DB }, new URL(req.url))).json();
  };
  assert.equal((await invoke(['single'])).changed, 1);
  assert.equal((await invoke(['expired-one', 'future-one', 'expired-last'])).changed, 2);
  assert.equal(sqlite.prepare("SELECT deleted_at FROM polls WHERE id='future-one'").get().deleted_at, null);
  assert.equal(sqlite.prepare("SELECT deleted_at FROM polls WHERE id='not-selected'").get().deleted_at, null);
  assert.equal((await invoke(['future-one'], 'archive')).changed, 1);
});

test('注册需要服务端 Turnstile，通过验证后才消费邮件码；邮箱大小写共享锁定', async t => {
  const { sqlite, DB } = database(); t.after(() => sqlite.close());
  const { default: worker } = await import('../src/index.js?review-regression');
  const env = { DB, TURNSTILE_SECRET: 'fixture-only', TURNSTILE_HOSTNAMES: 'fixture.invalid' };
  const ctx = { waitUntil(promise) { promise.catch(() => {}); } };
  const health = await worker.fetch(new Request('https://fixture.invalid/health'), env, ctx);
  assert.equal(health.status, 200, await health.text());
  const email = 'review@example.invalid';
  sqlite.prepare('INSERT INTO verification_codes (email,code,expires_at,sent_at,attempts) VALUES(?,?,?,?,0)').run(email, '123456', Date.now() + 600000, Date.now());
  let verificationCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    verificationCalls++;
    const value = init.body.get('response');
    return Response.json({ success: value !== 'invalid', action: value === 'register-proof' ? 'register' : 'login', hostname: 'fixture.invalid' });
  });
  const input = { email, username: 'fixture-user', password: 'fixture-pass-123', code: '123456' };
  for (const token of [undefined, 'invalid', 'login-proof']) {
    const response = await worker.fetch(request('/auth/register', { ...input, 'cf-turnstile-response': token }), env, ctx);
    assert.equal(response.status, 403);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM verification_codes').get().n, 1);
  }
  const registered = await worker.fetch(request('/auth/register', { ...input, 'cf-turnstile-response': 'register-proof' }), env, ctx);
  assert.equal(registered.status, 200, await registered.text());
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM verification_codes').get().n, 0);
  assert.equal(verificationCalls, 3);
  const login = account => worker.fetch(request('/auth/login', { account, password: 'wrong-password', 'cf-turnstile-response': 'login-proof' }), env, ctx);
  for (let i = 0; i < 5; i++) assert.equal((await login(email)).status, 401);
  assert.equal((await login(email.toUpperCase())).status, 429);
  assert.equal((await login('Review@Example.Invalid')).status, 429);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 1);
});
