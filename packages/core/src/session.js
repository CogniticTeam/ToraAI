// 会话持久化：~/.vega/sessions/<id>.json
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_DIR } from './config.js';

function sessionPath(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('非法会话 ID');
  return join(SESSIONS_DIR, `${id}.json`);
}

export function createSession(title = '新会话') {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const session = { id, title, created: now, updated: now, messages: [] };
  writeFileSync(sessionPath(id), JSON.stringify(session, null, 2));
  return session;
}

export function listSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
        return {
          id: s.id, title: s.title, created: s.created, updated: s.updated,
          messageCount: s.messages?.length ?? 0
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

export function loadSession(id) {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function saveSession(session) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  session.updated = new Date().toISOString();
  // 标题自动取自首条用户消息
  if (session.title === '新会话') {
    const firstUser = session.messages?.find((m) => m.role === 'user');
    if (firstUser) session.title = (typeof firstUser.content === 'string' ? firstUser.content : '会话')
      .slice(0, 24).replace(/\s+/g, ' ');
  }
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
  return session;
}

export function deleteSession(id) {
  const p = sessionPath(id);
  if (existsSync(p)) unlinkSync(p);
  return true;
}

export function sessionStats(id) {
  try { return { size: statSync(sessionPath(id)).size }; } catch { return { size: 0 }; }
}
