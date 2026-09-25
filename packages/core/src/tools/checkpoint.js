// 检查点与回滚：每轮工具执行前对工作目录做快照（内容寻址，不依赖 git）
//
// 这是敢开 bypass 模式的前提：模型改坏一片文件时，能「回到第 N 轮」。
// 不用 git —— 项目可能根本不是 git 仓库，而且 git 无法回滚未提交的中间态。
//
// 存储布局（~/.cocode/checkpoints/<sessionId>/）：
//   objects/<sha1>      内容寻址的文件快照（同内容只存一份）
//   cp-<id>.json        时间线节点：{ id, turn, parent, label, at, cwd, entries }
//   meta.json           { nextId, currentId } —— currentId 是工作区当前所在的节点
//
// 时间线分支：每个节点有 parent 指针。回滚到旧节点后继续快照，新节点的 parent
// 指向旧节点，形成分支（旧的"未来"节点不会被覆盖）。
//
// 回滚语义：把清单里的文件写回原内容，并删除"当前存在但清单里没有"的
// 受管文件（即快照之后新增的）。受管范围 = 非忽略目录下的普通文件。
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { IGNORE_DIRS } from './repomap.js';
import { COCODE_DIR } from '../config.js';

export const CHECKPOINTS_DIR = join(COCODE_DIR, 'checkpoints');
const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件上限（超过不入快照）
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 单个快照总量上限
const MAX_FILES = 8000;
const KEEP_NODES = 30; // 每个分支保留的节点数（分支化后总量可能 > 10）

function safeId(id) {
  if (!/^[\w-]+$/.test(String(id || ''))) throw new Error('非法会话 ID');
  return String(id);
}

function sessionDir(sessionId) {
  return join(CHECKPOINTS_DIR, safeId(sessionId));
}

function metaPath(sessionId) {
  return join(sessionDir(sessionId), 'meta.json');
}

function readMeta(sessionId) {
  try { return JSON.parse(readFileSync(metaPath(sessionId), 'utf8')); }
  catch { return { nextId: 1, currentId: null }; }
}

function writeMeta(sessionId, meta) {
  writeFileSync(metaPath(sessionId), JSON.stringify(meta));
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

/** 遍历受管文件（跳过依赖/产物目录与隐藏目录） */
export function listManagedFiles(cwd) {
  const out = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 12 || out.length >= MAX_FILES || visited > 40000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES || visited > 40000) return;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      visited++;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue; // 符号链接等一律跳过，避免跟随到沙箱外
      out.push(full);
    }
  };
  walk(cwd, 0);
  return out;
}

/** 读取所有时间线节点（新旧格式兼容）。旧格式 turn-<n>.json → id=n, parent=n-1。 */
function listNodes(sessionId) {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) return [];
  const nodes = [];
  for (const f of readdirSync(dir)) {
    let m = /^cp-(\d+)\.json$/.exec(f);
    if (m) {
      try {
        const mf = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        nodes.push({ ...mf, id: mf.id ?? Number(m[1]) });
      } catch { /* corrupt, skip */ }
      continue;
    }
    m = /^turn-(\d+)\.json$/.exec(f);
    if (m) {
      try {
        const mf = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const turn = Number(m[1]);
        nodes.push({
          id: turn, turn, parent: turn > 0 ? turn - 1 : null,
          label: mf.label ?? null, at: mf.at ?? null, cwd: mf.cwd ?? null,
          fileCount: mf.fileCount ?? 0, bytes: mf.bytes ?? 0, entries: mf.entries ?? {},
        });
      } catch { /* corrupt, skip */ }
    }
  }
  return nodes.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
}

function manifestPathById(sessionId, id) {
  return join(sessionDir(sessionId), `cp-${id}.json`);
}

/** 按 id 读节点清单（兼容旧 turn-<n>.json）。 */
function readNode(sessionId, id) {
  const p = manifestPathById(sessionId, id);
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  }
  // 兼容旧格式：id 即 turn 号
  const old = join(sessionDir(sessionId), `turn-${id}.json`);
  if (existsSync(old)) {
    try {
      const mf = JSON.parse(readFileSync(old, 'utf8'));
      return { id, turn: id, parent: id > 0 ? id - 1 : null, ...mf };
    } catch { return null; }
  }
  return null;
}

/** 回收没有被任何节点引用的对象，并裁剪旧节点。 */
function gcObjects(sessionId) {
  const dir = sessionDir(sessionId);
  const objectsDir = join(dir, 'objects');
  if (!existsSync(objectsDir)) return;
  const nodes = listNodes(sessionId);
  // 按分支裁剪：从 currentId 沿 parent 回溯保留最近 KEEP_NODES 个；
  // 其余分支（非当前祖先链）也各自保留最近 KEEP_NODES 个，避免把别的分支全删了。
  const live = new Set();
  const keep = new Set();
  // 当前链
  let cur = readMeta(sessionId).currentId;
  let depth = 0;
  while (cur != null && depth < KEEP_NODES) {
    keep.add(cur);
    const n = readNode(sessionId, cur);
    if (!n) break;
    cur = n.parent ?? null;
    depth++;
  }
  // 其它分支：保留 at 最新的 KEEP_NODES 个（按分支分组）
  const byParent = new Map();
  for (const n of nodes) {
    if (n.parent == null) continue;
    if (!byParent.has(n.parent)) byParent.set(n.parent, []);
    byParent.get(n.parent).push(n);
  }
  // 简单策略：所有不在当前链上的节点，按 at 排序保留最新 KEEP_NODES 个
  const others = nodes.filter((n) => !keep.has(n.id)).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  for (let i = 0; i < Math.min(others.length, KEEP_NODES); i++) keep.add(others[i].id);

  for (const n of nodes) {
    if (!keep.has(n.id)) {
      try { unlinkSync(manifestPathById(sessionId, n.id)); } catch { /* ignore */ }
      // 旧格式 turn-<n>.json 也尝试删
      try { unlinkSync(join(sessionDir(sessionId), `turn-${n.id}.json`)); } catch { /* ignore */ }
    }
  }
  for (const n of nodes) {
    if (!keep.has(n.id)) continue;
    for (const h of Object.values(n.entries || {})) live.add(h);
  }
  let removed = 0;
  for (const f of readdirSync(objectsDir)) {
    if (live.has(f)) continue;
    try { unlinkSync(join(objectsDir, f)); removed++; } catch { /* ignore */ }
  }
  return { removedObjects: removed, keptNodes: keep.size };
}

/**
 * 对工作目录做一次快照，作为时间线上的新节点。
 * @param {string} cwd
 * @param {{sessionId:string, turn:number, label?:string}} opts
 * @returns {{ok:boolean, id?:number, turn?:number, fileCount?:number, bytes?:number, skipped?:number, parent?:number|null, reason?:string}}
 */
export function snapshot(cwd, { sessionId, turn, label }) {
  if (!cwd || !sessionId || !Number.isFinite(turn)) return { ok: false, reason: '缺少 cwd / sessionId / turn' };
  const dir = sessionDir(sessionId);
  const objectsDir = join(dir, 'objects');
  mkdirSync(objectsDir, { recursive: true });

  const meta = readMeta(sessionId);
  const id = meta.nextId++;
  const parent = meta.currentId;

  const entries = {};
  let bytes = 0;
  let skipped = 0;
  for (const full of listManagedFiles(cwd)) {
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
    if (bytes + st.size > MAX_TOTAL_BYTES) { skipped++; continue; }
    let buf;
    try { buf = readFileSync(full); } catch { skipped++; continue; }
    const h = sha1(buf);
    const objPath = join(objectsDir, h);
    if (!existsSync(objPath)) {
      try { writeFileSync(objPath, buf); } catch { skipped++; continue; }
    }
    bytes += st.size;
    entries[relative(cwd, full).split(sep).join('/')] = h;
  }

  const manifest = {
    id, turn, parent, label: label || null, at: new Date().toISOString(), cwd,
    fileCount: Object.keys(entries).length, bytes, skipped, entries
  };
  writeFileSync(manifestPathById(sessionId, id), JSON.stringify(manifest));
  meta.currentId = id;
  writeMeta(sessionId, meta);
  const gc = gcObjects(sessionId);
  return { ok: true, id, turn, parent, fileCount: manifest.fileCount, bytes, skipped, gc };
}

/**
 * 列出该会话的时间线节点，带 current 标记。
 * 按 at 升序返回（旧→新），前端可自行排序。
 */
export function listCheckpoints(sessionId) {
  const meta = readMeta(sessionId);
  return listNodes(sessionId).map((n) => ({
    id: n.id,
    turn: n.turn,
    parent: n.parent ?? null,
    at: n.at || null,
    fileCount: n.fileCount ?? 0,
    bytes: n.bytes ?? 0,
    label: n.label ?? null,
    current: n.id === meta.currentId,
  }));
}

/** 当前工作区所在的检查点 id（回滚后指向被回滚的节点）。 */
export function getCurrentCheckpointId(sessionId) {
  return readMeta(sessionId).currentId;
}

/**
 * 回滚到指定检查点：写回清单里的文件，删除清单之后新增的文件。
 * 回滚后 currentId 指向该节点，后续快照会以它为 parent（形成分支）。
 * @returns {{ok:boolean, restored?:number, deleted?:number, missing?:number, target?:string, reason?:string}}
 */
export function restore(sessionId, id, cwd) {
  const manifest = readNode(sessionId, id);
  if (!manifest) return { ok: false, reason: `没有找到 id=${id} 的检查点` };
  const target = cwd || manifest.cwd;
  if (!target || !existsSync(target)) return { ok: false, reason: `工作目录不存在: ${target}` };
  const objectsDir = join(sessionDir(sessionId), 'objects');

  let restored = 0, deleted = 0, missing = 0;
  const wanted = new Set(Object.keys(manifest.entries));
  for (const [rel, hash] of Object.entries(manifest.entries)) {
    const objPath = join(objectsDir, hash);
    if (!existsSync(objPath)) { missing++; continue; }
    const dest = join(target, rel);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(objPath));
      restored++;
    } catch { /* 单个文件失败不中断 */ }
  }
  // 快照里没有、但现在有的 → 是快照之后新建的，回滚时删掉
  for (const full of listManagedFiles(target)) {
    const rel = relative(target, full).split(sep).join('/');
    if (wanted.has(rel)) continue;
    try { unlinkSync(full); deleted++; } catch { /* ignore */ }
  }
  // 更新 currentId：工作区现在处于这个节点
  const meta = readMeta(sessionId);
  meta.currentId = Number(id);
  writeMeta(sessionId, meta);
  return { ok: true, restored, deleted, missing, target };
}

/** 删掉某个会话的全部检查点 */
export function clearCheckpoints(sessionId) {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) return { ok: true, cleared: false };
  try { rmSync(dir, { recursive: true, force: true }); } catch { return { ok: false }; }
  return { ok: true, cleared: true };
}

export const checkpointTool = {
  name: 'Checkpoint',
  description:
    '查看/创建/回滚工作目录检查点（时间线）。每轮开始前系统会自动建点；如果改坏了文件，' +
    '用 action=restore + id=<节点id> 回到那个节点（会覆盖文件、删除该节点之后新增的文件）。' +
    '回滚后继续工作会形成时间线分支，旧的"未来"节点仍保留。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'restore'], description: 'list 列出时间线；create 手动建点；restore 回滚到某节点' },
      id: { type: 'number', description: 'restore 时的目标节点 id（list 返回的 id）' },
      turn: { type: 'number', description: '兼容旧用法：restore 的目标轮号（等同 id）' },
      label: { type: 'string', description: 'create 时的备注' }
    },
    required: ['action']
  },
  async execute({ action, id, turn, label }, ctx) {
    const sessionId = ctx?.sessionId;
    if (!sessionId) return '工具不可用：当前没有会话上下文，无法使用检查点。';
    if (action === 'list') {
      const list = listCheckpoints(sessionId);
      if (!list.length) return '当前会话还没有检查点（每轮工具执行前会自动创建）。';
      return '检查点时间线：\n' + list.map((c) => `  id=${c.id} 第${c.turn}轮 ${c.current ? '←当前' : ''} ${c.fileCount} 文件 ${new Date(c.at).toLocaleString('zh-CN')}${c.label ? ` · ${c.label}` : ''}${c.parent != null ? ` (parent=${c.parent})` : ''}`).join('\n');
    }
    if (action === 'create') {
      const t = ctx?.currentTurn ?? 0;
      const r = snapshot(ctx.cwd, { sessionId, turn: t, label: label || 'manual' });
      return r.ok ? `已创建检查点 id=${r.id}（第 ${r.turn} 轮，${r.fileCount} 个文件）。` : `创建失败: ${r.reason}`;
    }
    if (action === 'restore') {
      const n = Number(id ?? turn);
      if (!Number.isFinite(n)) return '参数错误：restore 需要 id 或 turn。';
      const r = restore(sessionId, n, ctx.cwd);
      return r.ok
        ? `已回滚到 id=${n}：写回 ${r.restored} 个文件，删除 ${r.deleted} 个之后新增的文件。后续快照将形成分支。`
        : `回滚失败: ${r.reason}`;
    }
    return `未知 action: ${action}`;
  }
};

export const checkpointTools = [checkpointTool];
