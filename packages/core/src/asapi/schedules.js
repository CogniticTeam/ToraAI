// 定时任务（Schedule）：cron 定时触发 agent 运行。
//
// 持久化：
//   ~/.cocode/schedules.json       —— 任务记录数组（结构对齐前端 ScheduleRecord）
//   ~/.cocode/schedule-runs.json   —— 执行历史 { scheduleId: [{session_id, at}] }
//
// 运行时：startScheduler() 单例 setInterval（unref，不挂住进程退出），
//   每 20 秒按任务各自的时区做一次 5 段 cron 匹配；同一「分钟键」只触发一次。
//   触发动作通过 setScheduleFireHandler 注入（server.js 负责建会话 + startChatRun），
//   避免本模块与 bridge/store 形成循环依赖。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COCODE_DIR } from '../config.js';

const SCHEDULES_PATH = join(COCODE_DIR, 'schedules.json');
const RUNS_PATH = join(COCODE_DIR, 'schedule-runs.json');
const TICK_MS = 20_000;
const MAX_RUNS_PER_SCHEDULE = 50;

let timer = null;
/** @type {(sched: object) => Promise<string|null>|string|null} */
let fireHandler = null;
// 已触发的「分钟键」，防止同一分钟内 tick 重复触发（进程内有效）
const firedKeys = new Set();

function ensureDir() {
  mkdirSync(dirname(SCHEDULES_PATH), { recursive: true });
}

function genId() {
  return 'sch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------- cron 解析 / 匹配 ----------------

const FIELD_BOUNDS = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6],  // day of week（0=周日；兼容写法 7 → 0）
];

/** 解析单个 cron 字段为数值集合。非法时抛 Error（中文信息）。 */
function parseField(raw, min, max, label) {
  const out = new Set();
  for (const part of String(raw).split(',')) {
    let step = 1;
    let body = part;
    if (body.includes('/')) {
      const [b, s] = body.split('/');
      if (!/^\d+$/.test(s)) throw new Error(`${label}：步长 "${s}" 非法`);
      step = Number(s);
      if (step < 1) throw new Error(`${label}：步长必须 ≥ 1`);
      body = b;
    }
    let lo = min, hi = max;
    if (body !== '*') {
      if (body.includes('-')) {
        const [a, b] = body.split('-');
        if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) throw new Error(`${label}：范围 "${body}" 非法`);
        lo = Number(a); hi = Number(b);
      } else {
        if (!/^\d+$/.test(body)) throw new Error(`${label}："${body}" 不是合法值`);
        lo = Number(body); hi = lo;
      }
      if (lo < min || hi > max || lo > hi) throw new Error(`${label}：值超出范围 ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** 校验 5 段 cron；非法抛错。 */
export function validateCron(expr) {
  const seg = String(expr ?? '').trim().split(/\s+/);
  if (seg.length !== 5) throw new Error('cron 表达式必须为 5 段（分 时 日 月 周）');
  const labels = ['分钟', '小时', '日期', '月份', '星期'];
  seg.forEach((s, i) => parseField(s, FIELD_BOUNDS[i][0], FIELD_BOUNDS[i][1], labels[i]));
}

/**
 * 标准 cron 语义匹配。parts：{minute,hour,day,month,dow}（均为时区下的本地值）。
 * 日期与星期同时被限制（都不是 *）时取「或」，其余取「与」（vixie cron 行为）。
 */
export function cronMatches(expr, parts) {
  const seg = String(expr).trim().split(/\s+/);
  if (seg.length !== 5) return false;
  let fields;
  try {
    fields = seg.map((s, i) => parseField(s, FIELD_BOUNDS[i][0], FIELD_BOUNDS[i][1], ''));
  } catch { return false; }
  const [minutes, hours, doms, months, dows] = fields;
  if (fields[4].has(7)) { fields[4].delete(7); fields[4].add(0); }
  if (!minutes.has(parts.minute) || !hours.has(parts.hour) || !months.has(parts.month)) return false;
  const domMatch = doms.has(parts.day);
  const dowMatch = dows.has(parts.dow);
  const domRestricted = seg[2] !== '*';
  const dowRestricted = seg[4] !== '*';
  return (domRestricted && dowRestricted) ? (domMatch || dowMatch) : (domMatch && dowMatch);
}

const WEEKDAY_TO_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 取某时刻在指定时区下的 cron 时间部件。时区非法时回退 UTC。 */
export function tzParts(date, timeZone) {
  let tz = timeZone;
  const fmt = () => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  });
  let out;
  try {
    out = fmt().formatToParts(date);
  } catch {
    tz = 'UTC';
    out = fmt().formatToParts(date);
  }
  const map = {};
  for (const p of out) if (p.type !== 'literal') map[p.type] = p.value;
  const hour = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(map.minute),
    dow: WEEKDAY_TO_NUM[map.weekday] ?? 0,
  };
}

// ---------------- 持久化 CRUD ----------------

export function listSchedules() {
  if (!existsSync(SCHEDULES_PATH)) return [];
  let list = [];
  try { list = JSON.parse(readFileSync(SCHEDULES_PATH, 'utf8')) || []; }
  catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function getSchedule(id) {
  return listSchedules().find((s) => s.id === id) || null;
}

function saveSchedules(list) {
  ensureDir();
  writeFileSync(SCHEDULES_PATH, JSON.stringify(list, null, 2));
}

/** 新建任务。body 字段对齐前端 CreateScheduleRequest。 */
export function createSchedule(body = {}) {
  const now = new Date().toISOString();
  const record = {
    id: genId(),
    created_at: now,
    updated_at: now,
    user_id: 'local',
    agent_id: String(body.agent_id || ''),
    data: {
      name: String(body.name || '未命名任务'),
      description: String(body.description ?? ''),
      enabled: body.enabled !== false,
      timezone: String(body.timezone || 'UTC'),
      cron_expression: String(body.cron_expression || '').trim(),
      started_at: now,
      ended_at: null,
      chat_model_config: body.chat_model_config || null,
      stateful: !!body.stateful,
      permission_mode: String(body.permission_mode || 'dont_ask'),
      source: 'USER',
      source_session_id: '',
    },
  };
  const list = listSchedules();
  list.push(record);
  saveSchedules(list);
  return record;
}

const UPDATABLE = ['name', 'description', 'enabled', 'timezone', 'cron_expression', 'stateful', 'permission_mode', 'ended_at'];

/** 更新任务（patch 为 data 层字段）。返回新记录；不存在返回 null。 */
export function updateSchedule(id, patch = {}) {
  const list = listSchedules();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  if (patch.cron_expression !== undefined) validateCron(patch.cron_expression);
  for (const key of UPDATABLE) {
    if (patch[key] !== undefined) list[idx].data[key] = patch[key];
  }
  list[idx].updated_at = new Date().toISOString();
  saveSchedules(list);
  return list[idx];
}

export function deleteSchedule(id) {
  const list = listSchedules().filter((s) => s.id !== id);
  saveSchedules(list);
  // 执行历史一并清理
  const runs = readRunsAll();
  if (runs[id]) {
    delete runs[id];
    saveRunsAll(runs);
  }
  return { ok: true };
}

// ---------------- 执行历史 ----------------

function readRunsAll() {
  if (!existsSync(RUNS_PATH)) return {};
  try { return JSON.parse(readFileSync(RUNS_PATH, 'utf8')) || {}; }
  catch { return {}; }
}

function saveRunsAll(all) {
  ensureDir();
  writeFileSync(RUNS_PATH, JSON.stringify(all, null, 2));
}

/** 追加一条触发记录（session_id 可能为 null = 触发失败）。 */
export function recordRun(scheduleId, sessionId) {
  const all = readRunsAll();
  const arr = all[scheduleId] || [];
  arr.unshift({ session_id: sessionId, at: new Date().toISOString() });
  if (arr.length > MAX_RUNS_PER_SCHEDULE) arr.length = MAX_RUNS_PER_SCHEDULE;
  all[scheduleId] = arr;
  saveRunsAll(all);
}

export function listRuns(scheduleId) {
  return readRunsAll()[scheduleId] || [];
}

// ---------------- 调度运行时 ----------------

export function setScheduleFireHandler(fn) {
  fireHandler = typeof fn === 'function' ? fn : null;
}

/** 评估一轮：匹配到点的任务并触发（供定时器与测试调用）。 */
export async function evaluateSchedules(now = new Date()) {
  const fired = [];
  for (const sched of listSchedules()) {
    if (!sched.data?.enabled) continue;
    const parts = tzParts(now, sched.data.timezone || 'UTC');
    const key = `${sched.id}:${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    if (firedKeys.has(key)) continue;
    if (!cronMatches(sched.data.cron_expression, parts)) continue;
    firedKeys.add(key);
    let sessionId = null;
    try {
      sessionId = fireHandler ? await fireHandler(sched) : null;
    } catch {
      // 触发失败不重试（分钟键已标记），避免失败风暴；历史里留 null 可审计
    }
    recordRun(sched.id, sessionId);
    fired.push({ scheduleId: sched.id, sessionId });
    // 一次性任务（日、月两段均固定）：触发后自动停用
    const seg = sched.data.cron_expression.trim().split(/\s+/);
    if (seg[2] !== '*' && seg[3] !== '*') updateSchedule(sched.id, { enabled: false });
  }
  if (firedKeys.size > 1000) {
    for (const k of [...firedKeys].slice(0, 500)) firedKeys.delete(k);
  }
  return fired;
}

/** 启动调度单例（幂等；interval unref 不阻止进程退出）。 */
export function startScheduler() {
  if (timer) return timer;
  evaluateSchedules().catch(() => {});
  timer = setInterval(() => { evaluateSchedules().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  return timer;
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}
