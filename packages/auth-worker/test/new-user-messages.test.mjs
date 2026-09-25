import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ensureMessageCampaigns, sendMessage, listSentMessages, recallMessage } from '../src/admin-messages.js';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT);
    CREATE TABLE account_messages (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, body TEXT, created_at TEXT, batch_id TEXT, recalled_at TEXT);
    CREATE TABLE message_translations (message_id TEXT, target_language TEXT, title TEXT, body TEXT);
    CREATE TABLE admin_audit (action TEXT, user_id INTEGER, detail TEXT, created_at TEXT);`);
  const DB = {
    prepare(sql) {
      const statement = args => ({
        bind: (...values) => statement(values),
        first: async () => sqlite.prepare(sql).get(...args) || null,
        all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
        run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
      });
      return statement([]);
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const pushes = [];
  const env = { DB, ACCOUNT_EVENTS: { idFromName: name => name, get: () => ({ fetch: async (_, request) => { pushes.push(JSON.parse(request.body)); return Response.json({ delivered: 0 }); } }) } };
  await ensureMessageCampaigns(DB);
  const add = id => sqlite.prepare('INSERT INTO users VALUES (?, ?, ?)').run(id, 'user' + id, `user${id}@example.invalid`);
  const inbox = id => sqlite.prepare('SELECT * FROM account_messages WHERE user_id = ? AND recalled_at IS NULL').all(id);
  const send = includeNewUsers => sendMessage(env, { target: null, title: '通知', body: '正文', includeNewUsers });
  return { sqlite, env, add, inbox, send, pushes };
}

test('勾选仅补发给之后创建的用户，每人一次；不勾选不补发', async () => {
  const f = await fixture();
  try {
    f.add(1);
    const persistent = await f.send(true); assert.equal(persistent.data.recipients, 1);
    await f.send(false); assert.equal(f.inbox(1).length, 2);
    f.add(2); assert.equal(f.inbox(2).length, 1);
    assert.equal(f.inbox(2)[0].batch_id, persistent.data.dispatchId);
    f.sqlite.exec("UPDATE users SET username = 'renamed' WHERE id = 2");
    await ensureMessageCampaigns(f.env.DB);
    assert.equal(f.inbox(2).length, 1);
    const history = await listSentMessages(f.env, 0);
    const row = history.messages.find(m => m.dispatch_id === persistent.data.dispatchId);
    assert.equal(row.recipients, 2); assert.equal(row.include_new_users, 1);
  } finally { f.sqlite.close(); }
});
test('撤回同时清除已有收件，停止新用户发放，重复撤回不重复审计', async () => {
  const f = await fixture();
  try {
    f.add(1); const sent = await f.send(true); f.add(2);
    const recalled = await recallMessage(f.env, sent.data.dispatchId);
    assert.equal(recalled.data.recalled, 2);
    assert.equal(f.inbox(1).length, 0); assert.equal(f.inbox(2).length, 0);
    f.add(3); assert.equal(f.inbox(3).length, 0);
    assert.equal((await recallMessage(f.env, sent.data.dispatchId)).data.recalled, 0);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS total FROM admin_audit WHERE action='message-recall'").get().total, 1);
    assert.ok((await listSentMessages(f.env, 0)).messages[0].recalled_at);
  } finally { f.sqlite.close(); }
});
test('零用户也可发布给后续用户，并能在历史中找到和撤回', async () => {
  const f = await fixture();
  try {
    const sent = await f.send(true); assert.equal(sent.status, 200); assert.equal(sent.data.recipients, 0);
    const history = await listSentMessages(f.env, 0); assert.equal(history.messages.length, 1); assert.equal(history.messages[0].include_new_users, 1);
    await recallMessage(f.env, sent.data.dispatchId); f.add(1); assert.equal(f.inbox(1).length, 0);
    const next = await f.send(true); f.add(2); assert.equal(f.inbox(2)[0].batch_id, next.data.dispatchId);
  } finally { f.sqlite.close(); }
});
test('兼容旧消息撤回，定向消息不会补发给新用户', async () => {
  const f = await fixture();
  try {
    f.add(1);
    f.sqlite.exec("INSERT INTO account_messages VALUES ('legacy',1,'旧通知','正文','2026-09-21',NULL,NULL)");
    await sendMessage(f.env, { target: 1, title: '私人通知', body: '仅本人可见', includeNewUsers: false });
    const history = await listSentMessages(f.env, 0); assert.equal(history.messages.length, 2);
    assert.equal((await recallMessage(f.env, 'legacy')).data.recalled, 1);
    f.add(2); assert.equal(f.inbox(2).length, 0);
  } finally { f.sqlite.close(); }
});
