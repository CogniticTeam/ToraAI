// 投票数据与权限完全以 D1 / Worker 为准。客户端离线队列不代表已经投票成功。
import { pollWorkbook } from './poll-xlsx.js';
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const MAX_OPTIONS = 20;
const MAX_POLL_OFFSET = 1_000_000;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
});
const bad = (detail, status = 400) => json({ detail }, status);
const iso = value => value == null ? null : new Date(value).toISOString();
const numberFlag = value => value === true ? 1 : 0;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const bounded = (value, max) => String(value ?? '').trim().slice(0, max + 1);
const bool = value => value === true || value === 1;

function stateOf(poll, now = Date.now()) {
  if (poll.status === 'archived') return 'archived';
  if (poll.status !== 'published') return 'draft';
  if (poll.start_at > now) return 'scheduled';
  if (poll.end_at != null && poll.end_at <= now) return 'ended';
  return 'active';
}

function serializePoll(poll, now = Date.now()) {
  return {
    id: poll.id, title: poll.title, description: poll.description, cover: poll.cover,
    note: poll.note, type: poll.type, maxSelections: poll.max_selections,
    audience: poll.audience, groupId: poll.group_id, frequency: poll.frequency,
    resultVisibility: poll.result_visibility, showVoterCount: !!poll.show_voter_count,
    showDetails: !!poll.show_details, pinned: !!poll.pinned,
    state: stateOf(poll, now), status: poll.status,
    startAt: iso(poll.start_at), endAt: iso(poll.end_at),
    createdAt: iso(poll.created_at), updatedAt: iso(poll.updated_at),
    publishedAt: iso(poll.published_at), archivedAt: iso(poll.archived_at),
    ...(poll.my_vote_count == null ? {} : { myVoteCount: poll.my_vote_count }),
  };
}

async function settings(db) {
  const { results } = await db.prepare('SELECT key, value FROM poll_settings').all();
  const values = Object.fromEntries((results || []).map(row => [row.key, row.value]));
  return {
    enabled: values.enabled !== '0',
    entryVisible: values.entry_visible !== '0',
    ipLimitEnabled: values.ip_limit_enabled === '1',
    deviceLimitEnabled: values.device_limit_enabled === '1',
  };
}

async function optionsFor(db, pollId) {
  const { results } = await db.prepare('SELECT id, label, note, position FROM poll_options WHERE poll_id = ? ORDER BY position').bind(pollId).all();
  return results || [];
}

async function pollFor(db, id) {
  return db.prepare('SELECT * FROM polls WHERE id = ? AND deleted_at IS NULL').bind(id).first();
}

async function canSee(db, poll, userId) {
  if (poll.audience === 'all') return true;
  if (!poll.group_id) return false;
  return !!(await db.prepare('SELECT 1 FROM poll_group_members WHERE group_id = ? AND user_id = ?').bind(poll.group_id, userId).first());
}

async function audit(db, action, pollId, userId = null, detail = '') {
  await db.prepare('INSERT INTO poll_audit (action, poll_id, user_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(action, pollId, userId, detail, Date.now()).run();
}

async function resultData(db, poll) {
  const count = await db.prepare('SELECT COUNT(*) AS participants, COUNT(DISTINCT user_id) AS users FROM poll_votes WHERE poll_id = ? AND deleted_at IS NULL').bind(poll.id).first();
  const { results } = await db.prepare(`SELECT o.id, o.label, o.note, o.position,
    COUNT(v.id) AS votes,
    AVG(CASE WHEN v.id IS NOT NULL THEN vi.score END) AS average_score,
    SUM(CASE WHEN v.id IS NOT NULL THEN vi.score ELSE 0 END) AS score_total
    FROM poll_options o
    LEFT JOIN poll_vote_items vi ON vi.option_id = o.id
    LEFT JOIN poll_votes v ON v.id = vi.vote_id AND v.deleted_at IS NULL
    WHERE o.poll_id = ? GROUP BY o.id ORDER BY o.position`).bind(poll.id).all();
  const totalSelections = (results || []).reduce((sum, row) => sum + (poll.type === 'score' ? (row.score_total || 0) : row.votes), 0);
  const now = Date.now();
  const trend = await db.prepare(`SELECT
    SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent,
    SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS previous
    FROM poll_votes WHERE poll_id = ? AND deleted_at IS NULL`)
    .bind(now - DAY_MS, now - 2 * DAY_MS, now - DAY_MS, poll.id).first();
  return {
    poll: serializePoll(poll), participants: count?.participants ?? 0, uniqueUsers: count?.users ?? 0,
    growthRate: trend?.previous ? ((trend.recent || 0) - trend.previous) / trend.previous : null,
    options: (results || []).map(row => ({
      id: row.id, label: row.label, note: row.note, votes: row.votes,
      selectionRate: count?.participants ? row.votes / count.participants : 0,
      share: totalSelections ? (poll.type === 'score' ? (row.score_total || 0) : row.votes) / totalSelections : 0,
      averageScore: row.average_score == null ? null : Number(row.average_score),
      scoreTotal: row.score_total || 0,
    })),
  };
}

async function voteItemsFor(db, voteIds) {
  if (!voteIds.length) return new Map();
  const placeholders = voteIds.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT vi.vote_id, vi.option_id, vi.score, o.label
    FROM poll_vote_items vi JOIN poll_options o ON o.id = vi.option_id
    WHERE vi.vote_id IN (${placeholders}) ORDER BY o.position`).bind(...voteIds).all();
  const byVote = new Map(voteIds.map(id => [id, []]));
  for (const item of results || []) byVote.get(item.vote_id)?.push({ optionId: item.option_id, label: item.label, score: item.score });
  return byVote;
}

async function fingerprint(secret, kind, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(kind + ':' + value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function handleUserPoll(request, env, url, user) {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const config = await settings(db);
  if (path === '/polls/config' && method === 'GET') return json({ enabled: config.enabled, entryVisible: config.entryVisible });
  if (!config.enabled) return bad('投票功能已暂停', 403);

  if (path === '/polls' && method === 'GET') {
    const q = bounded(url.searchParams.get('q'), 120);
    const type = url.searchParams.get('type') || '';
    const state = url.searchParams.get('state') || '';
    const createdFrom = Date.parse(url.searchParams.get('createdFrom') || '') || 0;
    const createdTo = Date.parse(url.searchParams.get('createdTo') || '') || Number.MAX_SAFE_INTEGER;
    const deadlineFrom = Date.parse(url.searchParams.get('deadlineFrom') || '') || 0;
    const deadlineTo = Date.parse(url.searchParams.get('deadlineTo') || '') || Number.MAX_SAFE_INTEGER;
    const offset = Math.min(MAX_POLL_OFFSET, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    if (type && !['single', 'multiple', 'score'].includes(type)) return bad('投票类型无效', 422);
    if (state && !['scheduled', 'active', 'ended'].includes(state)) return bad('状态无效', 422);
    const now = Date.now();
    const stateClause = state === 'scheduled' ? 'AND p.start_at > ?' : state === 'active' ? 'AND p.start_at <= ? AND (p.end_at IS NULL OR p.end_at > ?)' : state === 'ended' ? 'AND p.end_at IS NOT NULL AND p.end_at <= ?' : '';
    const stateArgs = state === 'active' ? [now, now] : state ? [now] : [];
    const { results } = await db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM poll_votes v WHERE v.poll_id = p.id AND v.user_id = ? AND v.deleted_at IS NULL) AS my_vote_count
      FROM polls p WHERE p.status = 'published' AND p.deleted_at IS NULL
      AND (p.audience = 'all' OR EXISTS (SELECT 1 FROM poll_group_members gm WHERE gm.group_id = p.group_id AND gm.user_id = ?))
      AND instr(lower(p.title), lower(?)) > 0 AND (? = '' OR p.type = ?)
      AND p.created_at >= ? AND p.created_at <= ?
      AND (p.end_at IS NULL OR p.end_at >= ?) AND (p.end_at IS NULL OR p.end_at <= ?)
      ${stateClause}
      ORDER BY p.pinned DESC, p.created_at DESC, p.id DESC LIMIT 51 OFFSET ?`)
      .bind(user.id, user.id, q, type, type, createdFrom, createdTo, deadlineFrom, deadlineTo, ...stateArgs, offset).all();
    const page = (results || []).slice(0, 50);
    return json({ polls: page.map(row => serializePoll(row)), nextOffset: (results || []).length > 50 ? offset + 50 : null });
  }

  if (path === '/polls/history' && method === 'GET') {
    const from = Date.parse(url.searchParams.get('from') || '') || 0;
    const to = Date.parse(url.searchParams.get('to') || '') || Number.MAX_SAFE_INTEGER;
    const offset = Math.min(10000, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const { results } = await db.prepare(`SELECT v.id, v.poll_id, v.created_at, p.title, p.type, p.status
      FROM poll_votes v JOIN polls p ON p.id = v.poll_id
      WHERE v.user_id = ? AND v.deleted_at IS NULL AND p.deleted_at IS NULL
      AND v.created_at >= ? AND v.created_at <= ?
      ORDER BY v.created_at DESC LIMIT 51 OFFSET ?`).bind(user.id, from, to, offset).all();
    const page = (results || []).slice(0, 50);
    const items = await voteItemsFor(db, page.map(row => row.id));
    return json({ votes: page.map(row => ({ id: row.id, pollId: row.poll_id, title: row.title, type: row.type, createdAt: iso(row.created_at), items: items.get(row.id) || [] })), nextOffset: (results || []).length > 50 ? offset + 50 : null });
  }

  const detail = path.match(/^\/polls\/([a-zA-Z0-9-]{1,100})$/);
  if (detail && method === 'GET') {
    const poll = await pollFor(db, detail[1]);
    if (!poll || poll.status !== 'published' || !(await canSee(db, poll, user.id))) return bad('投票不存在', 404);
    const count = await db.prepare('SELECT COUNT(*) AS total FROM poll_votes WHERE poll_id = ? AND user_id = ? AND deleted_at IS NULL').bind(poll.id, user.id).first();
    return json({ poll: { ...serializePoll(poll), myVoteCount: count?.total || 0 }, options: await optionsFor(db, poll.id) });
  }

  const results = path.match(/^\/polls\/([a-zA-Z0-9-]{1,100})\/results$/);
  if (results && method === 'GET') {
    const poll = await pollFor(db, results[1]);
    if (!poll || poll.status === 'draft' || !(await canSee(db, poll, user.id))) return bad('投票不存在', 404);
    if (poll.result_visibility === 'admin' || (poll.result_visibility === 'after_end' && !['ended', 'archived'].includes(stateOf(poll)))) return bad('结果尚未公开', 403);
    const data = await resultData(db, poll);
    if (!poll.show_details) data.options = [];
    if (!poll.show_voter_count) { delete data.participants; delete data.uniqueUsers; }
    delete data.growthRate;
    return json(data);
  }

  const vote = path.match(/^\/polls\/([a-zA-Z0-9-]{1,100})\/votes$/);
  if (vote && method === 'POST') {
    const poll = await pollFor(db, vote[1]);
    if (!poll || poll.status !== 'published' || !(await canSee(db, poll, user.id))) return bad('投票不存在', 404);
    if (stateOf(poll) !== 'active') return bad('投票尚未开始或已经结束', 409);
    const body = await request.json().catch(() => null);
    if (!body || !validId(body.submissionId)) return bad('提交标识无效', 422);
    const choices = Array.isArray(body.items) ? body.items : [];
    const optionIds = new Set((await optionsFor(db, poll.id)).map(option => option.id));
    if (!choices.length || choices.length > MAX_OPTIONS || choices.some(item => !item || !optionIds.has(item.optionId)) || new Set(choices.map(item => item.optionId)).size !== choices.length) return bad('请选择有效选项', 422);
    if (poll.type === 'single' && choices.length !== 1) return bad('单选只能选择一项', 422);
    if (poll.type === 'multiple' && choices.length > poll.max_selections) return bad('选择数量超过上限', 422);
    if (poll.type === 'score' && (choices.length !== optionIds.size || choices.some(item => !Number.isInteger(item.score) || item.score < 0 || item.score > 100))) return bad('请为每个选项填写 0–100 的整数分', 422);
    const existing = await db.prepare('SELECT id, deleted_at FROM poll_votes WHERE poll_id = ? AND user_id = ? AND submission_id = ?').bind(poll.id, user.id, body.submissionId).first();
    if (existing) return existing.deleted_at == null ? json({ ok: true, voteId: existing.id, alreadySubmitted: true }) : bad('此提交记录已由管理员删除，不能重复提交', 409);
    const now = Date.now();
    const day = new Date(Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
    const slot = poll.frequency === 'once' ? 'once' : poll.frequency === 'daily' ? day : body.submissionId;
    if ((config.ipLimitEnabled || config.deviceLimitEnabled) && !env.POLL_FRAUD_SECRET) return bad('防刷配置未完成，请联系管理员', 503);
    const ip = request.headers.get('cf-connecting-ip');
    const device = String(body.deviceId || '');
    if (config.ipLimitEnabled && !ip) return bad('无法验证网络来源', 422);
    if (config.deviceLimitEnabled && !/^[a-zA-Z0-9-]{16,100}$/.test(device)) return bad('无法验证设备标识', 422);
    const ipHash = config.ipLimitEnabled ? await fingerprint(env.POLL_FRAUD_SECRET, 'ip', ip) : null;
    const deviceHash = config.deviceLimitEnabled ? await fingerprint(env.POLL_FRAUD_SECRET, 'device', device) : null;
    const id = crypto.randomUUID();
    const statements = [];
    if (ipHash) statements.push(db.prepare('INSERT OR IGNORE INTO poll_fraud_claims (poll_id, kind, fingerprint, user_id) VALUES (?, ?, ?, ?)').bind(poll.id, 'ip', ipHash, user.id));
    if (deviceHash) statements.push(db.prepare('INSERT OR IGNORE INTO poll_fraud_claims (poll_id, kind, fingerprint, user_id) VALUES (?, ?, ?, ?)').bind(poll.id, 'device', deviceHash, user.id));
    const voteIndex = statements.length;
    statements.push(db.prepare(`INSERT INTO poll_votes (id, poll_id, user_id, submission_id, slot_key, ip_hash, device_hash, created_at)
      SELECT ?, p.id, ?, ?, ?, ?, ?, ? FROM polls p
      WHERE p.id = ? AND p.status = 'published' AND p.deleted_at IS NULL AND p.start_at <= ? AND (p.end_at IS NULL OR p.end_at > ?)
      AND (p.audience = 'all' OR EXISTS (SELECT 1 FROM poll_group_members gm WHERE gm.group_id = p.group_id AND gm.user_id = ?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM poll_fraud_claims c WHERE c.poll_id = p.id AND c.kind = 'ip' AND c.fingerprint = ? AND c.user_id = ?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM poll_fraud_claims c WHERE c.poll_id = p.id AND c.kind = 'device' AND c.fingerprint = ? AND c.user_id = ?))`)
      .bind(id, user.id, body.submissionId, slot, ipHash, deviceHash, now, poll.id, now, now, user.id, ipHash, ipHash, user.id, deviceHash, deviceHash, user.id));
    for (const item of choices) statements.push(db.prepare('INSERT INTO poll_vote_items (vote_id, option_id, score) VALUES (?, ?, ?)').bind(id, item.optionId, poll.type === 'score' ? item.score : null));
    try {
      const output = await db.batch(statements);
      if (!output[voteIndex]?.meta?.changes) return bad('该投票已不可参与，或网络/设备限制不允许提交', 409);
      return json({ ok: true, voteId: id, createdAt: iso(now) }, 201);
    } catch (error) {
      if (/UNIQUE|FOREIGN KEY|constraint/i.test(String(error))) return bad('已达到该投票的参与次数，或提交内容已失效', 409);
      throw error;
    }
  }
  return bad('Not Found', 404);
}

function inputFrom(body, previous = null, previousOptions = []) {
  const now = Date.now();
  const start = body.startAt === undefined ? (previous?.start_at ?? now) : Date.parse(body.startAt);
  const end = body.endAt === undefined ? (previous?.end_at ?? null) : body.endAt === null || body.endAt === '' ? null : Date.parse(body.endAt);
  const rawOptions = body.options === undefined ? previousOptions : body.options;
  return {
    title: bounded(body.title === undefined ? previous?.title : body.title, 120),
    description: bounded(body.description === undefined ? previous?.description : body.description, 5000),
    cover: bounded(body.cover === undefined ? previous?.cover : body.cover, 250000),
    note: bounded(body.note === undefined ? previous?.note : body.note, 1000),
    startAt: start, endAt: end,
    type: body.type ?? previous?.type ?? 'single',
    maxSelections: body.maxSelections ?? previous?.max_selections ?? 1,
    audience: body.audience ?? previous?.audience ?? 'all',
    groupId: body.groupId === undefined ? (previous?.group_id ?? null) : body.groupId,
    frequency: body.frequency ?? previous?.frequency ?? 'once',
    resultVisibility: body.resultVisibility ?? previous?.result_visibility ?? 'live',
    showVoterCount: body.showVoterCount === undefined ? (previous ? !!previous.show_voter_count : true) : bool(body.showVoterCount),
    showDetails: body.showDetails === undefined ? (previous ? !!previous.show_details : true) : bool(body.showDetails),
    options: Array.isArray(rawOptions) ? rawOptions.map((option, index) => ({
      id: validId(option?.id) ? option.id : crypto.randomUUID(),
      label: bounded(option?.label, 120), note: bounded(option?.note, 300), position: index,
    })) : null,
  };
}

async function validateInput(db, input, publish = false) {
  if (!Number.isFinite(input.startAt) || input.startAt < 0 || (input.endAt !== null && (!Number.isFinite(input.endAt) || input.endAt <= input.startAt))) return '开始和截止时间无效';
  if (input.title.length > 120 || input.description.length > 5000 || input.note.length > 1000) return '文字长度超过上限';
  if (input.cover.length > 250000 || (input.cover && !/^https:\/\/\S+$/i.test(input.cover) && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(input.cover))) return '封面应为 HTTPS 图片地址或小于 250KB 的图片';
  if (!['single', 'multiple', 'score'].includes(input.type) || !['all', 'group'].includes(input.audience) || !['once', 'daily', 'unlimited'].includes(input.frequency) || !['live', 'after_end', 'admin'].includes(input.resultVisibility)) return '投票配置无效';
  if (!Number.isInteger(input.maxSelections) || input.maxSelections < 1 || input.maxSelections > MAX_OPTIONS) return '最多选择项数无效';
  if (!input.options || input.options.length > MAX_OPTIONS || input.options.some(option => !option.label && publish || option.label.length > 120 || option.note.length > 300)) return '选项配置无效';
  if (new Set(input.options.map(option => option.id)).size !== input.options.length) return '选项 ID 不可重复';
  if (publish) {
    if (!input.title || input.options.length < 2 || new Set(input.options.map(option => option.label)).size !== input.options.length) return '发布前需填写标题和至少两个不同选项';
    if (input.type === 'multiple' && input.maxSelections > input.options.length) return '多选上限不能超过选项数量';
    if (input.endAt != null && input.endAt <= Date.now()) return '已过截止时间，不能发布';
    if (input.audience === 'group') {
      if (!validId(input.groupId)) return '请选择指定用户组';
      const group = await db.prepare('SELECT 1 FROM poll_groups WHERE id = ?').bind(input.groupId).first();
      if (!group) return '用户组不存在';
    }
  }
  return null;
}

function pollStatement(db, id, input, now, published = false) {
  return db.prepare(`INSERT INTO polls (id,title,description,cover,note,start_at,end_at,type,max_selections,audience,group_id,frequency,result_visibility,show_voter_count,show_details,status,created_at,updated_at,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, input.title, input.description, input.cover, input.note, input.startAt, input.endAt,
    input.type, input.maxSelections, input.audience, input.audience === 'group' ? input.groupId : null,
    input.frequency, input.resultVisibility, numberFlag(input.showVoterCount), numberFlag(input.showDetails),
    published ? 'published' : 'draft', now, now, published ? now : null,
  );
}

function optionInsertStatements(db, id, options) {
  return options.map(option => db.prepare('INSERT INTO poll_options (id,poll_id,label,note,position) VALUES (?,?,?,?,?)')
    .bind(option.id, id, option.label, option.note, option.position));
}

async function adminVotePage(db, pollId, offset = 0) {
  const { results } = await db.prepare(`SELECT v.id, v.user_id, v.created_at, u.username, u.email
    FROM poll_votes v JOIN users u ON u.id = v.user_id
    WHERE v.poll_id = ? AND v.deleted_at IS NULL
    ORDER BY v.created_at DESC LIMIT 101 OFFSET ?`).bind(pollId, offset).all();
  const page = (results || []).slice(0, 100);
  const items = await voteItemsFor(db, page.map(row => row.id));
  return {
    votes: page.map(row => ({ id: row.id, userId: row.user_id, username: row.username, email: row.email, createdAt: iso(row.created_at), items: items.get(row.id) || [] })),
    nextOffset: (results || []).length > 100 ? offset + 100 : null,
  };
}

export async function handleAdminPoll(request, env, url) {
  const db = env.DB;
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/admin/polls/settings') {
    if (method === 'GET') return json(await settings(db));
    if (method !== 'PATCH') return bad('Method Not Allowed', 405);
    const body = await request.json().catch(() => ({}));
    for (const field of ['enabled', 'entryVisible', 'ipLimitEnabled', 'deviceLimitEnabled']) if (body[field] !== undefined && typeof body[field] !== 'boolean') return bad(`${field} 必须为布尔值`, 422);
    if ((body.ipLimitEnabled || body.deviceLimitEnabled) && !env.POLL_FRAUD_SECRET) return bad('请先设置 POLL_FRAUD_SECRET', 503);
    const keys = { enabled: 'enabled', entryVisible: 'entry_visible', ipLimitEnabled: 'ip_limit_enabled', deviceLimitEnabled: 'device_limit_enabled' };
    const changes = Object.entries(keys).filter(([field]) => body[field] !== undefined);
    if (changes.length) await db.batch(changes.map(([field, key]) => db.prepare('INSERT INTO poll_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, body[field] ? '1' : '0')));
    await audit(db, 'settings', null, null, JSON.stringify(Object.fromEntries(changes.map(([field]) => [field, body[field]]))));
    return json(await settings(db));
  }

  if (path === '/admin/polls/groups' && method === 'GET') {
    const { results } = await db.prepare(`SELECT g.id, g.name, g.created_at, COUNT(m.user_id) AS members
      FROM poll_groups g LEFT JOIN poll_group_members m ON m.group_id = g.id
      GROUP BY g.id ORDER BY g.created_at DESC`).all();
    return json({ groups: (results || []).map(group => ({ id: group.id, name: group.name, members: group.members, createdAt: iso(group.created_at) })) });
  }
  if (path === '/admin/polls/groups' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = bounded(body.name, 80);
    if (!name || name.length > 80) return bad('组名需为 1–80 字', 422);
    const id = crypto.randomUUID();
    try { await db.prepare('INSERT INTO poll_groups (id,name,created_at) VALUES (?,?,?)').bind(id, name, Date.now()).run(); }
    catch (error) { if (/UNIQUE/i.test(String(error))) return bad('组名已存在', 409); throw error; }
    await audit(db, 'group-create', null, null, id);
    return json({ id, name }, 201);
  }
  const groupMatch = path.match(/^\/admin\/polls\/groups\/([a-zA-Z0-9-]{1,100})$/);
  if (groupMatch && method === 'PATCH') {
    const body = await request.json().catch(() => ({}));
    const name = bounded(body.name, 80);
    if (!name || name.length > 80) return bad('组名需为 1–80 字', 422);
    try {
      const result = await db.prepare('UPDATE poll_groups SET name = ? WHERE id = ?').bind(name, groupMatch[1]).run();
      if (!result.meta.changes) return bad('用户组不存在', 404);
    } catch (error) { if (/UNIQUE/i.test(String(error))) return bad('组名已存在', 409); throw error; }
    await audit(db, 'group-rename', null, null, groupMatch[1]);
    return json({ ok: true });
  }
  if (groupMatch && method === 'DELETE') {
    const used = await db.prepare("SELECT 1 FROM polls WHERE group_id = ? AND deleted_at IS NULL AND status != 'archived' LIMIT 1").bind(groupMatch[1]).first();
    if (used) return bad('用户组仍被投票使用，不能删除', 409);
    const result = await db.prepare('DELETE FROM poll_groups WHERE id = ?').bind(groupMatch[1]).run();
    if (!result.meta.changes) return bad('用户组不存在', 404);
    await audit(db, 'group-delete', null, null, groupMatch[1]);
    return json({ ok: true });
  }
  const membersMatch = path.match(/^\/admin\/polls\/groups\/([a-zA-Z0-9-]{1,100})\/members$/);
  if (membersMatch && method === 'GET') {
    const { results } = await db.prepare(`SELECT u.id, u.username, u.email FROM poll_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.id DESC`).bind(membersMatch[1]).all();
    return json({ users: results || [] });
  }
  if (membersMatch && ['POST', 'DELETE'].includes(method)) {
    const body = await request.json().catch(() => ({}));
    const userId = Number(body.userId);
    if (!Number.isSafeInteger(userId) || userId < 1) return bad('账户 ID 无效', 422);
    const group = await db.prepare('SELECT 1 FROM poll_groups WHERE id = ?').bind(membersMatch[1]).first();
    if (!group) return bad('用户组不存在', 404);
    const target = await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(userId).first();
    if (!target) return bad('账户不存在', 404);
    if (method === 'POST') await db.prepare('INSERT OR IGNORE INTO poll_group_members (group_id,user_id) VALUES (?,?)').bind(membersMatch[1], userId).run();
    else await db.prepare('DELETE FROM poll_group_members WHERE group_id = ? AND user_id = ?').bind(membersMatch[1], userId).run();
    await audit(db, method === 'POST' ? 'group-add-member' : 'group-remove-member', null, userId, membersMatch[1]);
    return json({ ok: true });
  }

  if (path === '/admin/polls' && method === 'GET') {
    const q = bounded(url.searchParams.get('q'), 120);
    const limit = Math.min(300, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '300', 10) || 300));
    const offset = Math.min(MAX_POLL_OFFSET, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const { results } = await db.prepare(`SELECT * FROM polls WHERE deleted_at IS NULL AND instr(lower(title),lower(?)) > 0 ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(q, limit + 1, offset).all();
    const page = (results || []).slice(0, limit);
    return json({ polls: page.map(row => serializePoll(row)), nextOffset: (results || []).length > limit ? offset + limit : null });
  }
  if (path === '/admin/polls' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const input = inputFrom(body);
    const publish = body.publish === true;
    const error = await validateInput(db, input, publish);
    if (error) return bad(error, 422);
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.batch([pollStatement(db, id, input, now, publish), ...optionInsertStatements(db, id, input.options)]);
    await audit(db, publish ? 'create-publish' : 'create-draft', id);
    return json({ id, state: publish ? stateOf({ ...input, status: 'published', start_at: input.startAt, end_at: input.endAt }) : 'draft' }, 201);
  }

  if (path === '/admin/polls/bulk' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].filter(validId).slice(0, 100) : [];
    if (!ids.length || !['archive', 'delete-expired'].includes(body.action)) return bad('请选择有效投票与操作', 422);
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    const clause = body.action === 'archive' ? "status = 'published'" : 'end_at IS NOT NULL AND end_at <= ?';
    const binds = body.action === 'archive' ? [now, now, ...ids] : [now, now, now, ...ids];
    const sql = body.action === 'archive'
      ? `UPDATE polls SET status = 'archived', archived_at = ?, updated_at = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL AND ${clause}`
      : `UPDATE polls SET deleted_at = ?, updated_at = ? WHERE id IN (${placeholders}) AND deleted_at IS NULL AND ${clause}`;
    const result = await db.prepare(sql).bind(...binds).run();
    await audit(db, 'bulk-' + body.action, null, null, JSON.stringify(ids));
    return json({ ok: true, changed: result.meta.changes || 0 });
  }

  const idMatch = path.match(/^\/admin\/polls\/([a-zA-Z0-9-]{1,100})$/);
  if (idMatch) {
    const poll = await pollFor(db, idMatch[1]);
    if (!poll) return bad('投票不存在', 404);
    if (method === 'GET') return json({ poll: serializePoll(poll), options: await optionsFor(db, poll.id) });
    if (method === 'DELETE') {
      await db.prepare('UPDATE polls SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(Date.now(), Date.now(), poll.id).run();
      await audit(db, 'delete', poll.id);
      return json({ ok: true });
    }
    if (method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      if (poll.status === 'archived') return bad('归档活动不可编辑', 409);
      if (poll.published_at != null) {
        const allowed = new Set(['title', 'description', 'cover', 'note', 'endAt']);
        if (Object.keys(body).some(key => !allowed.has(key))) return bad('已发布活动仅能修改基础信息或延长截止时间', 422);
        const title = body.title === undefined ? poll.title : bounded(body.title, 120);
        const description = body.description === undefined ? poll.description : bounded(body.description, 5000);
        const cover = body.cover === undefined ? poll.cover : bounded(body.cover, 250000);
        const note = body.note === undefined ? poll.note : bounded(body.note, 1000);
        const end = body.endAt === undefined ? poll.end_at : body.endAt === null || body.endAt === '' ? null : Date.parse(body.endAt);
        if (!title || title.length > 120 || description.length > 5000 || note.length > 1000 || cover.length > 250000 || (cover && !/^https:\/\/\S+$/i.test(cover) && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(cover))) return bad('基础信息无效', 422);
        if (end !== null && (!Number.isFinite(end) || end < (poll.end_at ?? Date.now()) || end <= poll.start_at)) return bad('只能延长截止时间', 422);
        await db.prepare('UPDATE polls SET title = ?, description = ?, cover = ?, note = ?, end_at = ?, updated_at = ? WHERE id = ?')
          .bind(title, description, cover, note, end, Date.now(), poll.id).run();
      } else {
        const input = inputFrom(body, poll, await optionsFor(db, poll.id));
        const error = await validateInput(db, input, false);
        if (error) return bad(error, 422);
        const statements = [db.prepare(`UPDATE polls SET title=?,description=?,cover=?,note=?,start_at=?,end_at=?,type=?,max_selections=?,audience=?,group_id=?,frequency=?,result_visibility=?,show_voter_count=?,show_details=?,updated_at=? WHERE id=?`)
          .bind(input.title, input.description, input.cover, input.note, input.startAt, input.endAt, input.type, input.maxSelections, input.audience, input.audience === 'group' ? input.groupId : null, input.frequency, input.resultVisibility, numberFlag(input.showVoterCount), numberFlag(input.showDetails), Date.now(), poll.id),
          db.prepare('DELETE FROM poll_options WHERE poll_id = ?').bind(poll.id), ...optionInsertStatements(db, poll.id, input.options)];
        await db.batch(statements);
      }
      await audit(db, 'edit', poll.id);
      return json({ ok: true });
    }
    return bad('Method Not Allowed', 405);
  }

  const actionMatch = path.match(/^\/admin\/polls\/([a-zA-Z0-9-]{1,100})\/status$/);
  if (actionMatch && method === 'POST') {
    const poll = await pollFor(db, actionMatch[1]);
    if (!poll) return bad('投票不存在', 404);
    const body = await request.json().catch(() => ({}));
    const action = body.action;
    const now = Date.now();
    if (action === 'publish') {
      if (poll.status === 'archived') return bad('归档活动不能重新发布', 409);
      const error = await validateInput(db, inputFrom({}, poll, await optionsFor(db, poll.id)), true);
      if (error) return bad(error, 422);
      await db.prepare("UPDATE polls SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?").bind(now, now, poll.id).run();
    } else if (action === 'unpublish') {
      await db.prepare("UPDATE polls SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'published'").bind(now, poll.id).run();
    } else if (action === 'archive') {
      await db.prepare("UPDATE polls SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").bind(now, now, poll.id).run();
    } else if (action === 'pin' || action === 'unpin') {
      await db.prepare('UPDATE polls SET pinned = ?, updated_at = ? WHERE id = ?').bind(action === 'pin' ? 1 : 0, now, poll.id).run();
    } else return bad('状态操作无效', 422);
    await audit(db, action, poll.id);
    return json({ ok: true });
  }

  const resultMatch = path.match(/^\/admin\/polls\/([a-zA-Z0-9-]{1,100})\/results$/);
  if (resultMatch && method === 'GET') {
    const poll = await pollFor(db, resultMatch[1]);
    return poll ? json(await resultData(db, poll)) : bad('投票不存在', 404);
  }
  const votesMatch = path.match(/^\/admin\/polls\/([a-zA-Z0-9-]{1,100})\/votes$/);
  if (votesMatch && method === 'GET') {
    const poll = await pollFor(db, votesMatch[1]);
    if (!poll) return bad('投票不存在', 404);
    const offset = Math.min(10000, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    return json(await adminVotePage(db, poll.id, offset));
  }
  const exportMatch = path.match(/^\/admin\/polls\/([a-zA-Z0-9-]{1,100})\/export$/);
  if (exportMatch && method === 'GET') {
    const poll = await pollFor(db, exportMatch[1]);
    if (!poll) return bad('投票不存在', 404);
    const kind = url.searchParams.get('kind') || 'summary';
    if (!['summary', 'details'].includes(kind)) return bad('导出类型无效', 422);
    let rows;
    if (kind === 'summary') {
      const data = await resultData(db, poll);
      rows = [
        ['投票标题', '类型', '开始时间', '截止时间', '投票次数', '独立参与用户'],
        [poll.title, poll.type, new Date(poll.start_at), poll.end_at == null ? '永久有效' : new Date(poll.end_at), data.participants, data.uniqueUsers],
        [],
        ['选项', '票数', '选择率', '平均分', '分数总和'],
        ...data.options.map(option => [option.label, option.votes, { format: 'percent', value: option.selectionRate }, option.averageScore, option.scoreTotal]),
      ];
    } else {
      rows = [['记录 ID', '用户 ID', '用户名', '邮箱', '提交时间', '投票内容']];
      let offset = 0;
      while (true) {
        const { results } = await db.prepare(`SELECT v.id, v.user_id, v.created_at, u.username, u.email
          FROM poll_votes v JOIN users u ON u.id = v.user_id
          WHERE v.poll_id = ? AND v.deleted_at IS NULL ORDER BY v.created_at DESC LIMIT 500 OFFSET ?`).bind(poll.id, offset).all();
        const page = results || [];
        const items = await voteItemsFor(db, page.map(row => row.id));
        rows.push(...page.map(row => [row.id, row.user_id, row.username || '', row.email, new Date(row.created_at), (items.get(row.id) || []).map(item => item.score == null ? item.label : `${item.label}: ${item.score}`).join('；')]));
        offset += page.length;
        if (page.length < 500) break;
        if (offset >= 50000) return bad('投票记录超过 5 万条，请联系管理员分批导出', 413);
      }
    }
    const bytes = pollWorkbook(kind === 'summary' ? '投票汇总' : '用户明细', rows);
    return new Response(bytes, { headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="cocode-poll-${kind}-${poll.id}.xlsx"`,
      'cache-control': 'no-store', 'access-control-allow-origin': '*',
    } });
  }
  const deleteVote = path.match(/^\/admin\/polls\/([a-zA-Z0-9-]{1,100})\/votes\/([a-zA-Z0-9-]{1,100})$/);
  if (deleteVote && method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    const reason = bounded(body.reason, 500);
    if (!reason || reason.length > 500) return bad('请输入违规原因', 422);
    const target = await db.prepare('SELECT id,user_id,ip_hash,device_hash FROM poll_votes WHERE id = ? AND poll_id = ? AND deleted_at IS NULL').bind(deleteVote[2], deleteVote[1]).first();
    if (!target) return bad('投票记录不存在', 404);
    const now = Date.now();
    await db.prepare('UPDATE poll_votes SET deleted_at = ?, delete_reason = ? WHERE id = ?').bind(now, reason, target.id).run();
    for (const [kind, hash] of [['ip', target.ip_hash], ['device', target.device_hash]]) if (hash) {
      const remaining = await db.prepare(`SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ? AND deleted_at IS NULL AND ${kind === 'ip' ? 'ip_hash' : 'device_hash'} = ? LIMIT 1`).bind(deleteVote[1], target.user_id, hash).first();
      if (!remaining) await db.prepare('DELETE FROM poll_fraud_claims WHERE poll_id = ? AND kind = ? AND fingerprint = ? AND user_id = ?').bind(deleteVote[1], kind, hash, target.user_id).run();
    }
    await audit(db, 'delete-vote', deleteVote[1], target.user_id, `${target.id}: ${reason}`);
    return json({ ok: true });
  }

  return bad('Not Found', 404);
}
