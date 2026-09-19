// Team 存储：多智能体团队协作的元数据
//
// 持久化位置：
//   ~/.vega/teams.json           —— TeamRecord[]
//   ~/.vega/team-docs/{id}.md    —— 团队文档（队长可读写，work 共享上下文）
//
// TeamRecord 结构：
//   { id, created_at, updated_at, user_id, name, description,
//     leader_session_id, leader_agent_id, member_ids: string[], status: 'active'|'disbanded' }
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { VEGA_DIR } from '../config.js';

const TEAMS_PATH = join(VEGA_DIR, 'teams.json');
const TEAM_DOCS_DIR = join(VEGA_DIR, 'team-docs');

const now = () => new Date().toISOString();
const uid = () => 'team_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------- readJson / writeJson（store.js 的那俩是模块私有，这里复用同模式） ----------
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    console.warn(`[team-store] ${path} 解析失败，已隔离为 *.corrupt-*`);
    return fallback;
  }
}

function writeJson(path, data) {
  mkdirSync(VEGA_DIR, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function listAll() {
  const arr = readJson(TEAMS_PATH, []);
  return Array.isArray(arr) ? arr : [];
}

function saveAll(list) {
  writeJson(TEAMS_PATH, list);
}

// ---------- 导出 API ----------

/** 列出所有团队（含已解散）。 */
export function listTeams() {
  return { teams: listAll() };
}

/** 按 id 查团队，不存在返回 null。 */
export function getTeam(id) {
  return listAll().find((t) => t.id === id) || null;
}

/** 列出某队长（leader_session_id）名下的活跃团队。 */
export function getTeamByLeader(sessionId) {
  return listAll().find((t) => t.leader_session_id === sessionId && t.status === 'active') || null;
}

/** 创建团队。返回新 TeamRecord。 */
export function createTeam({ leader_session_id, leader_agent_id, name, description }) {
  const t = {
    id: uid(),
    created_at: now(),
    updated_at: now(),
    user_id: 'local',
    name: String(name || '').trim() || '未命名团队',
    description: String(description || '').trim(),
    leader_session_id,
    leader_agent_id,
    member_ids: [],
    status: 'active'
  };
  const list = listAll();
  list.push(t);
  saveAll(list);
  return t;
}

/** 更新团队名称/描述。返回更新后的 TeamRecord，不存在返回 null。 */
export function updateTeam(id, patch) {
  const list = listAll();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const t = list[i];
  if (patch.name !== undefined) t.name = String(patch.name).trim() || t.name;
  if (patch.description !== undefined) t.description = String(patch.description);
  t.updated_at = now();
  list[i] = t;
  saveAll(list);
  return t;
}

/** 添加成员 agent_id。已存在则跳过。 */
export function addTeamMember(team_id, agent_id) {
  const list = listAll();
  const i = list.findIndex((t) => t.id === team_id);
  if (i < 0) return;
  const t = list[i];
  if (!t.member_ids.includes(agent_id)) {
    t.member_ids.push(agent_id);
    t.updated_at = now();
    saveAll(list);
  }
}

/** 移除成员 agent_id。 */
export function removeTeamMember(team_id, agent_id) {
  const list = listAll();
  const i = list.findIndex((t) => t.id === team_id);
  if (i < 0) return;
  const t = list[i];
  t.member_ids = t.member_ids.filter((id) => id !== agent_id);
  t.updated_at = now();
  saveAll(list);
}

/** 解散团队：status='disbanded'，并删除 team-docs/{id}.md。 */
export function disbandTeam(team_id) {
  const list = listAll();
  const i = list.findIndex((t) => t.id === team_id);
  if (i < 0) return;
  list[i].status = 'disbanded';
  list[i].updated_at = now();
  saveAll(list);
  try { unlinkSync(getTeamDocPath(team_id)); } catch { /* 文件不存在也 OK */ }
}

/** 团队文档路径：~/.vega/team-docs/{team_id}.md */
export function getTeamDocPath(team_id) {
  return join(TEAM_DOCS_DIR, `${team_id}.md`);
}
