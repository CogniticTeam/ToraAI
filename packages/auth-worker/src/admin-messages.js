import { publishAccountEvent } from './account-events.js';

export async function ensureMessageCampaigns(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS message_campaigns (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      target_user_id INTEGER, include_new_users INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, recalled_at TEXT
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_future_message_campaigns ON message_campaigns(include_new_users, recalled_at)`),
    // 注册与收件在同一数据库事务完成；和发送、撤回串行化，避免漏发或撤回后补发。
    db.prepare(`CREATE TRIGGER IF NOT EXISTS deliver_future_messages AFTER INSERT ON users BEGIN
      INSERT INTO account_messages (id, user_id, title, body, created_at, batch_id)
      SELECT lower(hex(randomblob(16))), NEW.id, title, body, created_at, id
      FROM message_campaigns WHERE include_new_users = 1 AND target_user_id IS NULL AND recalled_at IS NULL;
    END`),
  ]);
}

export async function sendMessage(env, { target, title, body, includeNewUsers }) {
  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO message_campaigns (id, title, body, target_user_id, include_new_users, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ? = 1 OR EXISTS (SELECT 1 FROM users WHERE ? IS NULL OR id = ?)`)
      .bind(batchId, title, body, target, includeNewUsers ? 1 : 0, now, includeNewUsers ? 1 : 0, target, target),
    env.DB.prepare(`INSERT INTO account_messages (id, user_id, title, body, created_at, batch_id)
      SELECT lower(hex(randomblob(16))), u.id, c.title, c.body, c.created_at, c.id
      FROM users u JOIN message_campaigns c ON c.id = ? WHERE c.target_user_id IS NULL OR u.id = c.target_user_id`).bind(batchId),
    env.DB.prepare(`INSERT INTO admin_audit (action, user_id, detail, created_at)
      SELECT 'message', target_user_id, ?, created_at FROM message_campaigns WHERE id = ?`)
      .bind(JSON.stringify({ title, includeNewUsers, dispatchId: batchId }), batchId),
  ]);
  if (!results[0].meta.changes) return { status: 404, data: { detail: '没有匹配的接收账户' } };
  const push = await publishAccountEvent(env, target, { type: 'message-received' });
  return { status: 200, data: { ok: true, dispatchId: batchId, recipients: results[1].meta.changes, includeNewUsers, ...push } };
}

export async function listSentMessages(env, offset) {
  const { results } = await env.DB.prepare(`WITH sent AS (SELECT coalesce(m.batch_id, m.id) AS dispatch_id,
    min(m.title) AS title, min(m.body) AS body, min(m.created_at) AS created_at,
    count(*) AS recipients, sum(CASE WHEN m.recalled_at IS NULL THEN 1 ELSE 0 END) AS active,
    max(m.recalled_at) AS recalled_at,
    CASE WHEN count(*) = 1 THEN min(coalesce(u.username, u.email, '已删除账户')) ELSE '全部账户' END AS recipient
    FROM account_messages m LEFT JOIN users u ON u.id = m.user_id
    GROUP BY coalesce(m.batch_id, m.id))
    SELECT c.id AS dispatch_id, c.title, c.body, c.created_at, coalesce(s.recipients, 0) AS recipients,
      coalesce(s.active, 0) AS active, c.recalled_at,
      CASE WHEN c.target_user_id IS NULL THEN '全部账户' ELSE coalesce(s.recipient, '已删除账户') END AS recipient,
      c.include_new_users
    FROM message_campaigns c LEFT JOIN sent s ON s.dispatch_id = c.id
    UNION ALL SELECT s.*, 0 AS include_new_users FROM sent s WHERE NOT EXISTS (SELECT 1 FROM message_campaigns c WHERE c.id = s.dispatch_id)
    ORDER BY created_at DESC, dispatch_id DESC LIMIT 50 OFFSET ?`).bind(offset).all();
  return { messages: results, nextOffset: results.length === 50 ? offset + 50 : null };
}

export async function recallMessage(env, dispatchId) {
  const existing = await env.DB.prepare('SELECT count(*) AS total, min(user_id) AS user_id FROM account_messages WHERE coalesce(batch_id, id) = ?').bind(dispatchId).first();
  const campaign = await env.DB.prepare('SELECT id, target_user_id FROM message_campaigns WHERE id = ?').bind(dispatchId).first();
  if (!existing?.total && !campaign) return { status: 404, data: { detail: '消息不存在' } };
  const now = new Date().toISOString();
  // 保留原始消息与撤回时间供审计；更新、译文清理、审计记录在同一事务执行。
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO admin_audit (action, user_id, detail, created_at)
      SELECT 'message-recall', ?, ?, ? WHERE EXISTS (SELECT 1 FROM account_messages WHERE coalesce(batch_id, id) = ? AND recalled_at IS NULL)
      OR EXISTS (SELECT 1 FROM message_campaigns WHERE id = ? AND recalled_at IS NULL)`).bind(existing.total === 1 ? existing.user_id : null, dispatchId, now, dispatchId, dispatchId),
    env.DB.prepare('UPDATE message_campaigns SET recalled_at = ? WHERE id = ? AND recalled_at IS NULL').bind(now, dispatchId),
    env.DB.prepare('UPDATE account_messages SET recalled_at = ? WHERE coalesce(batch_id, id) = ? AND recalled_at IS NULL').bind(now, dispatchId),
    env.DB.prepare('DELETE FROM message_translations WHERE message_id IN (SELECT id FROM account_messages WHERE coalesce(batch_id, id) = ?)').bind(dispatchId),
  ]);
  // 重试仍发送失效事件，避免首次写入成功但推送临时失败时客户端漏更新。
  const push = await publishAccountEvent(env, campaign ? campaign.target_user_id : existing.total === 1 ? existing.user_id : null, { type: 'messages-changed' });
  return { status: 200, data: { ok: true, recalled: results[2].meta.changes, ...push } };
}
